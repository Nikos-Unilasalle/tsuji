import { useEffect } from "react";
import { createPortal } from "react-dom";
import { version } from "../../package.json";
import logoUrl from "../assets/logo.png";
import "./about-modal.css";

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AboutModal({ isOpen, onClose }: AboutModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="about-backdrop" onClick={onClose}>
      <div className="about-modal" role="dialog" aria-label="About tsuji" onClick={(e) => e.stopPropagation()}>
        <img src={logoUrl} alt="" className="about-logo" />
        <div className="about-name">
          tsu<span>ji</span>
        </div>
        <div className="about-tagline">2D/3D Motion design suite for creatives</div>
        <div className="about-rule" />
        <dl className="about-credits">
          <dt>Made by</dt>
          <dd>Unilasalle</dd>
          <dt>Design</dt>
          <dd>Nicolas Priniotakis</dd>
          <dt>Contact</dt>
          <dd>
            <a href="https://tsuji.xyz" target="_blank" rel="noreferrer">
              tsuji.xyz
            </a>
          </dd>
        </dl>
        <div className="about-version">Version {version}</div>
      </div>
    </div>,
    document.body,
  );
}
