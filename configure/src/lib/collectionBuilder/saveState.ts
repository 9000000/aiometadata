export type SaveStage = 'draft' | 'applied' | 'saved';

export interface SaveStageInput {
  builderJson: string;
  configJson: string;
  /** Null while no save target exists, so "clean" cannot be distinguished from "unknown". */
  configDirty: boolean | null;
}

export function deriveSaveStage({ builderJson, configJson, configDirty }: SaveStageInput): SaveStage {
  if (builderJson !== configJson) return 'draft';
  return configDirty === false ? 'saved' : 'applied';
}

export function describeSaveStage(stage: SaveStage): { label: string; hint: string } {
  if (stage === 'draft') {
    return { label: 'Draft', hint: 'These edits are not in your configuration yet.' };
  }
  if (stage === 'applied') {
    return { label: 'Applied', hint: 'In your configuration, not yet on the server.' };
  }
  return {
    label: 'Saved',
    hint: 'Applied and stored on the server. Your app still needs to import it again to show the change.',
  };
}
