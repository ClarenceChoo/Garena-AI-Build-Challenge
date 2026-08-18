"use client";

import {
  GameplaySearchWorkbench,
  type GameplayIndexSnapshot,
} from "./gameplay-search-workbench";

interface RealAnalysisWorkbenchProps {
  onIndexChange?: (snapshot: GameplayIndexSnapshot) => void;
}

export function RealAnalysisWorkbench({ onIndexChange }: RealAnalysisWorkbenchProps) {
  return <GameplaySearchWorkbench onIndexChange={onIndexChange} />;
}
