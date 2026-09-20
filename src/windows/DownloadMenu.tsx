import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  assetsFor,
  describeAsset,
  detectPlatform,
  formatSize,
  LATEST_RELEASE_API_URL,
  LAUNCH_NOTES,
  orderedPlatforms,
  PLATFORM_LABELS,
  Release,
  RELEASES_PAGE_URL,
} from "../shared/downloads";
import "./download-menu.css";

type LoadState = "idle" | "loading" | "ready" | "error";

/**
 * Download — the desktop builds, offered from the web app.
 *
 * The assets are fetched from the GitHub Releases API the first time the menu
 * opens, not at page load: most visits never touch this button, and the API
 * is rate-limited per IP (60/hour unauthenticated), so spending a request on
 * every page view would exhaust it for the people who do click.
 *
 * Every failure mode lands on the same fallback — a link to the Releases page
 * — because they are all the same thing from the visitor's side: no file to
 * hand them directly. That covers a rate-limited API, an offline visitor, and
 * the case that matters most before the first tag is cut, where the API
 * answers 404 because no release exists yet.
 */
export const DownloadMenu: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [release, setRelease] = useState<Release | null>(null);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const toggleOpen = () => {
    if (!isOpen && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      setPanelPos({
        top: rect.bottom + 6,
        right: Math.max(12, window.innerWidth - rect.right),
      });
    }
    setIsOpen((v) => !v);
  };

  const copyCommand = useCallback((command: string) => {
    // Clipboard access can be refused (insecure origin, denied permission),
    // and the command is on screen either way — so a failure just leaves the
    // label alone rather than raising anything.
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, []);

  const platform = detectPlatform(
    typeof navigator === "undefined" ? "" : navigator.userAgent,
    (navigator as { userAgentData?: { platform?: string } } | undefined)?.userAgentData?.platform,
  );

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(LATEST_RELEASE_API_URL, { headers: { Accept: "application/vnd.github+json" } });
      // 404 is not a failure: it is what the API answers while no release has
      // been published yet (a draft does not count as `latest`). Reporting it
      // as "could not reach GitHub" would blame the network for a repo that
      // simply has nothing to offer, so it settles into the empty-but-ready
      // state instead — which says exactly that.
      if (res.status === 404) {
        setRelease(null);
        setState("ready");
        return;
      }
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const data = (await res.json()) as Release;
      setRelease(data);
      setState("ready");
    } catch {
      // Deliberately quiet: the fallback link below is a complete answer, and
      // a console error on a button nobody has to use is noise.
      setRelease(null);
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    // Fetch once per session — a release does not appear mid-visit.
    if (state === "idle") void load();
    const onPointerDown = (e: MouseEvent | PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    const onScrollOrResize = () => setIsOpen(false);

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [isOpen, state, load]);

  const platforms = orderedPlatforms(platform);
  const hasAnyAsset = platforms.some((p) => assetsFor(p, release).length > 0);

  return (
    <div className="download-menu-root" ref={rootRef}>
      <button
        className={`top-bar-button top-bar-button-download${isOpen ? " top-bar-button-output-active" : ""}`}
        onClick={toggleOpen}
        title="Download the desktop app"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Download
      </button>

      {isOpen && (
        <div
          className="download-menu-panel"
          role="menu"
          style={panelPos ? { top: panelPos.top, right: panelPos.right } : { top: 44, right: 12 }}
        >
          <div className="download-menu-header">
            Desktop app
            {state === "ready" && release?.tag_name && (
              <span className="download-menu-version">{release.tag_name}</span>
            )}
          </div>

          {state === "loading" && <div className="download-menu-note">Looking for the latest release…</div>}

          {state === "ready" && hasAnyAsset &&
            platforms.map((p) => {
              const assets = assetsFor(p, release);
              if (assets.length === 0) return null;
              return (
                <div className="download-menu-group" key={p}>
                  <div className="download-menu-group-label">
                    {PLATFORM_LABELS[p]}
                    {p === platform && <span className="download-menu-badge">your system</span>}
                  </div>
                  {assets.map((asset) => (
                    <a
                      className="download-menu-item"
                      key={asset.name}
                      href={asset.browser_download_url}
                      // The asset lives on a different origin, so `download`
                      // is ignored anyway — the Content-Disposition GitHub
                      // sends is what makes it a download.
                      rel="noreferrer noopener"
                      onClick={() => setIsOpen(false)}
                    >
                      <span className="download-menu-item-label">{describeAsset(asset.name)}</span>
                      <span className="download-menu-item-desc">{formatSize(asset.size)}</span>
                    </a>
                  ))}
                </div>
              );
            })}

          {(state === "error" || (state === "ready" && !hasAnyAsset)) && (
            <div className="download-menu-note">
              {state === "error"
                ? "Could not reach GitHub right now."
                : "No binaries published yet."}
            </div>
          )}

          <a
            className="download-menu-item download-menu-fallback"
            href={RELEASES_PAGE_URL}
            target="_blank"
            rel="noreferrer noopener"
            onClick={() => setIsOpen(false)}
          >
            <span className="download-menu-item-label">All releases on GitHub ↗</span>
            <span className="download-menu-item-desc">Release notes and earlier builds</span>
          </a>

          {state === "ready" && hasAnyAsset && platform && (
            <div className="download-menu-note download-menu-note-quiet">
              {LAUNCH_NOTES[platform].text}
              {LAUNCH_NOTES[platform].command && (
                <button
                  type="button"
                  className="download-menu-command"
                  title="Copy to clipboard"
                  onClick={() => copyCommand(LAUNCH_NOTES[platform].command!)}
                >
                  <code>{LAUNCH_NOTES[platform].command}</code>
                  <span className="download-menu-command-hint">{copied ? "copied" : "copy"}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
