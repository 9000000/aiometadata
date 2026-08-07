import { createCollectionDraft, createFolderDraft, type BuilderEntry, type SourceDraft } from '@shared/types';
import type { ManifestCatalog } from './manifestSources';

const MIRROR_CAP = 24;

export interface StarterTemplate {
  id: string;
  label: string;
  hint: string;
  build: () => BuilderEntry[];
}

export interface TemplateInput {
  catalogs: ManifestCatalog[];
  /** Structural rather than TagOption, so this stays clear of the component tree. */
  tags: Array<{ name: string }>;
}

function toSource(catalog: ManifestCatalog): SourceDraft {
  return {
    catalogId: catalog.id,
    type: catalog.type,
    name: catalog.name,
    genre: catalog.genreRequired ? catalog.genres?.[0] ?? null : null,
  };
}

export function listStarterTemplates({ catalogs, tags }: TemplateInput): StarterTemplate[] {
  if (catalogs.length === 0) return [];
  const templates: StarterTemplate[] = [];

  if (tags.length > 0) {
    templates.push({
      id: 'by-tag',
      label: 'One folder per tag',
      hint: `${tags.length} folder${tags.length === 1 ? '' : 's'} from your tags`,
      build: () => {
        const collection = createCollectionDraft();
        collection.title = 'My catalogs';
        collection.folders = tags.map(tag => {
          const folder = createFolderDraft();
          folder.title = tag.name;
          folder.sources = catalogs
            .filter(catalog => (catalog.tags ?? []).includes(tag.name))
            .map(toSource);
          return folder;
        });
        return [collection];
      },
    });
  }

  const mirrored = Math.min(catalogs.length, MIRROR_CAP);
  templates.push({
    id: 'mirror',
    label: 'One folder with everything',
    hint: `The first ${mirrored} of your catalogs, in order`,
    build: () => {
      const collection = createCollectionDraft();
      collection.title = 'My catalogs';
      const folder = createFolderDraft();
      folder.title = 'All';
      folder.sources = catalogs.slice(0, MIRROR_CAP).map(toSource);
      collection.folders = [folder];
      return [collection];
    },
  });

  return templates;
}
