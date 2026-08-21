"use client";

import { useState } from "react";
import { RealAnalysisWorkbench } from "./real-analysis-workbench";
import type { GameplayIndexSnapshot } from "./gameplay-search-workbench";
import "./unseen-experience.css";

interface UnseenExperienceProps {
  viewer: { displayName: string; email: string } | null;
  signInPath: string;
  signOutPath: string;
}

const EMPTY_INDEX: GameplayIndexSnapshot = Object.freeze({
  clips: [],
  segments: [],
  eventCount: 0,
  isReady: false,
});

export function UnseenExperience({
  viewer,
  signInPath,
  signOutPath,
}: UnseenExperienceProps) {
  const [gameplayIndex, setGameplayIndex] = useState<GameplayIndexSnapshot>(EMPTY_INDEX);
  const indexReady = gameplayIndex.isReady && gameplayIndex.eventCount > 0;

  return (
    <main className="unseen-shell">
      <div className="unseen-ambient unseen-ambient-one" aria-hidden="true" />
      <div className="unseen-ambient unseen-ambient-two" aria-hidden="true" />

      <header className="unseen-header">
        <a className="unseen-brand" href="#unseen-tools" aria-label="UNSEEN home">
          <span className="unseen-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>UNSEEN</span>
        </a>
        <div className="header-actions">
          <div className={`auth-account ${viewer ? "is-signed-in" : "is-guest"}`}>
            <span aria-hidden="true" />
            <div>
              <strong title={viewer?.email}>{viewer?.displayName ?? "Guest viewer"}</strong>
              <a href={viewer ? signOutPath : signInPath}>{viewer ? "Sign out" : "Sign in"}</a>
            </div>
          </div>
          <div className="index-summary" aria-label={`${gameplayIndex.eventCount} indexed gameplay events`}>
            <span aria-hidden="true">●</span>
            {indexReady ? `${gameplayIndex.eventCount} events` : "No index"}
          </div>
          <button
            className="reconstruct-button"
            type="button"
            onClick={() => document.getElementById("unseen-tools")?.scrollIntoView({ behavior: "smooth" })}
          >
            Open tools
          </button>
        </div>
      </header>

      <RealAnalysisWorkbench onIndexChange={setGameplayIndex} />

      <footer className="unseen-footer">
        <a className="unseen-brand footer-brand" href="#unseen-tools">
          <span className="unseen-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>UNSEEN</span>
        </a>
        <p>Search · Coach · Create</p>
        <span>GARENA AI BUILD CHALLENGE · 2026</span>
      </footer>
    </main>
  );
}

export default UnseenExperience;
