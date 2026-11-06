use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use midir::{Ignore, MidiInput, MidiInputConnection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// One raw MIDI message, as the device sent it. Decoding (note on/off, CC…)
/// happens in the frontend (`midiRuntime.ts`), where it can be tested.
const MESSAGE_EVENT: &str = "midi:message";
/// The names of the MIDI inputs currently open.
const PORTS_EVENT: &str = "midi:ports";

/// macOS's WKWebView has no Web MIDI, so — like the gamepad (`gamepad.rs`) —
/// MIDI is read natively and relayed to the webview as events.
#[derive(Clone, Debug, Serialize)]
pub struct MidiMessage {
    pub port: String,
    pub bytes: Vec<u8>,
    /// Milliseconds since the bridge started, taken as the message arrives: the frontend groups notes struck
    /// together by it, and its own clock would be late whenever its thread is busy.
    pub time: f64,
}

/// The inputs the poller has open, for the `list_midi_inputs` command.
pub struct MidiHub {
    latest: Arc<Mutex<Vec<String>>>,
}

#[tauri::command]
pub fn list_midi_inputs(hub: tauri::State<'_, MidiHub>) -> Vec<String> {
    hub.latest.lock().unwrap().clone()
}

/// Every input port's (id, name) right now.
fn scan() -> Vec<(String, String)> {
    let Ok(input) = MidiInput::new("tsuji-scan") else {
        return Vec::new();
    };
    input
        .ports()
        .iter()
        .filter_map(|p| Some((p.id(), input.port_name(p).ok()?)))
        .collect()
}

fn open(handle: &AppHandle, id: &str, name: &str, epoch: Instant) -> Option<MidiInputConnection<()>> {
    let mut input = MidiInput::new("tsuji").ok()?;
    // Clock and active sensing would flood the webview with events nobody reads.
    input.ignore(Ignore::TimeAndActiveSense);
    let port = input.find_port_by_id(id.to_string())?;
    let handle = handle.clone();
    let port_name = name.to_string();
    match input.connect(
        &port,
        "tsuji-in",
        move |_stamp, bytes, _| {
            let time = epoch.elapsed().as_secs_f64() * 1000.0;
            let _ = handle.emit(MESSAGE_EVENT, MidiMessage { port: port_name.clone(), bytes: bytes.to_vec(), time });
        },
        (),
    ) {
        Ok(conn) => Some(conn),
        Err(e) => {
            eprintln!("midi: could not open {name}: {e}");
            None
        }
    }
}

pub fn init(app: &tauri::App) {
    let latest: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    app.manage(MidiHub { latest: latest.clone() });
    let handle = app.handle().clone();

    thread::spawn(move || {
        // Keyed by port id; dropping a connection closes it.
        let mut open_ports: HashMap<String, (String, MidiInputConnection<()>)> = HashMap::new();
        let epoch = Instant::now();
        let mut last_emit = Instant::now() - Duration::from_secs(10);
        loop {
            // Hot-plug: open what appeared, close what went away.
            let ports = scan();
            let mut changed = false;
            open_ports.retain(|id, _| {
                let keep = ports.iter().any(|(p, _)| p == id);
                changed |= !keep;
                keep
            });
            for (id, name) in &ports {
                if open_ports.contains_key(id) {
                    continue;
                }
                if let Some(conn) = open(&handle, id, name, epoch) {
                    eprintln!("midi: opened {name}");
                    open_ports.insert(id.clone(), (name.clone(), conn));
                    changed = true;
                }
            }
            let mut names: Vec<String> = open_ports.values().map(|(n, _)| n.clone()).collect();
            names.sort();
            *latest.lock().unwrap() = names.clone();
            // A heartbeat too: the webview's listener may attach after the first emit.
            if changed || last_emit.elapsed() >= Duration::from_secs(2) {
                let _ = handle.emit(PORTS_EVENT, names);
                last_emit = Instant::now();
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}
