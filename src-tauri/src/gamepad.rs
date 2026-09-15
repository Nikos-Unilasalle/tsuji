use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gilrs::{Axis, Button, Gilrs};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const STATE_EVENT: &str = "gamepad:state";

/// A controller reduced to what the frontend graph needs, laid out in the W3C
/// "standard gamepad" order so the existing browser-facing code — the deadzone
/// maths and the `STANDARD_BUTTONS` indices — keeps working unchanged.
#[derive(Clone, Debug, Serialize)]
pub struct GamepadSnapshot {
    pub connected: bool,
    pub id: String,
    pub axes: Vec<f32>,
    pub buttons: Vec<f32>,
}

/// W3C standard axes: left stick X/Y, then right stick X/Y.
const STANDARD_AXES: [Axis; 4] = [
    Axis::LeftStickX,
    Axis::LeftStickY,
    Axis::RightStickX,
    Axis::RightStickY,
];

/// W3C standard button order: A, B, X, Y, left/right bumper, left/right
/// trigger, back, start, left/right stick click, then the d-pad.
const STANDARD_BUTTONS: [Button; 16] = [
    Button::South,
    Button::East,
    Button::West,
    Button::North,
    Button::LeftTrigger,
    Button::RightTrigger,
    Button::LeftTrigger2,
    Button::RightTrigger2,
    Button::Select,
    Button::Start,
    Button::LeftThumb,
    Button::RightThumb,
    Button::DPadUp,
    Button::DPadDown,
    Button::DPadLeft,
    Button::DPadRight,
];

/// Shared between the background poller and the `list_gamepads` command: the
/// most recently emitted snapshot list. The poller owns `Gilrs` (it is `Send`
/// but not `Sync`), so the command reads this cache rather than the device.
pub struct GamepadHub {
    latest: Arc<Mutex<Vec<GamepadSnapshot>>>,
}

#[tauri::command]
pub fn list_gamepads(hub: tauri::State<'_, GamepadHub>) -> Vec<GamepadSnapshot> {
    hub.latest.lock().unwrap().clone()
}

fn snapshot(gamepad: &gilrs::Gamepad) -> GamepadSnapshot {
    // gilrs normalises every platform to "up is +1" for the stick Y axes, but
    // the browser convention the rest of the app assumes is "up is −1", so the
    // two vertical axes are flipped here.
    let axes = STANDARD_AXES
        .iter()
        .enumerate()
        .map(|(i, axis)| {
            let value = gamepad.value(*axis);
            if i == 1 || i == 3 { -value } else { value }
        })
        .collect();

    let buttons = STANDARD_BUTTONS
        .iter()
        .map(|button| gamepad.button_data(*button).map(|d| d.value()).unwrap_or(0.0))
        .collect();

    GamepadSnapshot {
        connected: true,
        id: gamepad.name().to_string(),
        axes,
        buttons,
    }
}

fn collect(gilrs: &Gilrs) -> Vec<GamepadSnapshot> {
    let mut pads: Vec<_> = gilrs
        .gamepads()
        .filter(|(_, pad)| pad.is_connected())
        .collect();
    // GamepadIds are stable-ish usize handles, not contiguous indices; sorting
    // them gives a deterministic 0..N ordering for the frontend's "player
    // index" wiring. `GamepadId` itself is not `Ord`, so sort on the usize it
    // converts into.
    pads.sort_by_key(|(id, _)| usize::from(*id));
    pads.into_iter().map(|(_, pad)| snapshot(&pad)).collect()
}

fn snapshots_differ(a: &[GamepadSnapshot], b: &[GamepadSnapshot]) -> bool {
    if a.len() != b.len() {
        return true;
    }
    a.iter().zip(b).any(|(x, y)| {
        x.id != y.id
            || x.connected != y.connected
            || x.axes.len() != y.axes.len()
            || x.buttons.len() != y.buttons.len()
            || x.axes.iter().zip(&y.axes).any(|(i, j)| (i - j).abs() > 1e-4)
            || x.buttons.iter().zip(&y.buttons).any(|(i, j)| (i - j).abs() > 1e-4)
    })
}

fn emit_if_changed(hub: &GamepadHub, handle: &AppHandle, snapshots: Vec<GamepadSnapshot>, force: bool) -> bool {
    let changed = {
        let mut guard = hub.latest.lock().unwrap();
        if force || snapshots_differ(&guard, &snapshots) {
            *guard = snapshots.clone();
            true
        } else {
            false
        }
    };
    if changed {
        if handle.emit(STATE_EVENT, snapshots).is_err() {
            eprintln!("gamepad: failed to emit state event");
        }
    }
    changed
}

pub fn init(app: &tauri::App) {
    let latest: Arc<Mutex<Vec<GamepadSnapshot>>> = Arc::new(Mutex::new(Vec::new()));
    app.manage(GamepadHub {
        latest: latest.clone(),
    });
    let handle = app.handle().clone();

    thread::spawn(move || {
        let mut gilrs = match Gilrs::new() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("gamepad: gilrs initialisation failed: {e}");
                return;
            }
        };

        let hub = GamepadHub { latest };

        // Seed immediately so a pad that is plugged in but untouched still
        // shows up — the one thing the browser API cannot do.
        let initial = collect(&gilrs);
        eprintln!("gamepad: gilrs ready, {} pad(s) detected", initial.len());
        {
            *hub.latest.lock().unwrap() = initial.clone();
        }
        let _ = handle.emit(STATE_EVENT, initial);

        // Re-emit on a slow heartbeat even when nothing changed: the frontend's
        // listener is only attached once the webview loads, so the startup emit
        // above can be lost. Forcing a refresh guarantees the UI converges.
        let mut last_emit = std::time::Instant::now();
        loop {
            let _ = gilrs.next_event_blocking(Some(Duration::from_millis(100)));
            let snapshots = collect(&gilrs);
            let heartbeat = last_emit.elapsed() >= Duration::from_secs(1);
            if emit_if_changed(&hub, &handle, snapshots, heartbeat) {
                last_emit = std::time::Instant::now();
            }
        }
    });
}
