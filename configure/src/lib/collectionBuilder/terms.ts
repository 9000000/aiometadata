export type Target = 'nuvio' | 'fusion';

export const NUVIO_CHIP = 'bg-cyan-800/70 text-cyan-200 border-cyan-600/50';
export const FUSION_CHIP = 'bg-violet-800/70 text-violet-200 border-violet-600/50';

export interface TargetTerms {
  entryTitle: string;
  collection: string;
  row: string;
  child: string;
  children: string;
  childTitle: string;
  addChild: string;
  shape: string;
  shapeOther: string;
  cover: string;
  sources: string;
}

/**
 * The same draft feeds both apps, but each names the pieces differently.
 * Fusion wording matches the labels Fusion tooling uses for the same fields
 * ("Widget Title", "Item Title", "Layout", "Aspect Ratio", "Image URL").
 */
export const TERMS: Record<Target, TargetTerms> = {
  nuvio: {
    entryTitle: 'Title',
    collection: 'Collection',
    row: 'Row',
    child: 'Folder',
    children: 'Folders',
    childTitle: 'Folder title',
    addChild: 'Add folder',
    shape: 'Tile shape',
    shapeOther: 'Fusion calls this layout',
    cover: 'Cover image URL',
    sources: 'Sources',
  },
  fusion: {
    entryTitle: 'Widget title',
    collection: 'Collection widget',
    row: 'Classic row',
    child: 'Item',
    children: 'Items',
    childTitle: 'Item title',
    addChild: 'Add item',
    shape: 'Layout',
    shapeOther: 'Nuvio calls this tileShape',
    cover: 'Image URL',
    sources: 'Catalogs',
  },
};
