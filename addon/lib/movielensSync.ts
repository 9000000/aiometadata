const database: any = require('./database');
const movielens: any = require('./movielens');
const imp: any = require('./movielensImport');
const mdbList: any = require('../utils/mdbList');
const traktUtils: any = require('../utils/traktUtils');
const simklUtils: any = require('../utils/simklUtils');
const consola: any = require('consola');

const logger = consola.withTag('movielens-sync');

async function getCursor(credId: string): Promise<any> {
  const row = await database.getOAuthToken(credId);
  if (!row) return null;
  try { return JSON.parse(row.scope || '{}'); } catch { return {}; }
}

async function setCursor(credId: string, cursor: any): Promise<void> {
  const row = await database.getOAuthToken(credId);
  if (!row) return;
  await database.saveOAuthToken(
    credId, 'movielens', row.user_id, row.access_token, row.refresh_token, row.expires_at, JSON.stringify(cursor)
  );
}

async function gatherRatings(config: any, since?: string): Promise<{ merged: any[]; perSource: Record<string, number> }> {
  const lists: any[][] = [];
  const perSource: Record<string, number> = {};

  const traktTokenId = config?.apiKeys?.traktTokenId;
  if (traktTokenId) {
    try {
      const tok = await database.getOAuthToken(traktTokenId);
      if (tok?.access_token) {
        let pull = true;
        if (since) {
          const activity = await traktUtils.fetchTraktLastActivity(tok.access_token);
          const ratedAt = activity?.movies?.rated_at;
          pull = !ratedAt || ratedAt > since;
        }
        if (pull) {
          const norm = imp.fromMovieRatingItems(await traktUtils.getTraktRatings(tok.access_token));
          lists.push(norm);
          perSource.trakt = norm.length;
        } else {
          perSource.trakt = 0;
        }
      }
    } catch (e: any) { logger.warn(`Trakt ratings fetch failed: ${e.message}`); }
  }

  const simklTokenId = config?.apiKeys?.simklTokenId;
  if (simklTokenId) {
    try {
      const tok = await simklUtils.getSimklToken(simklTokenId);
      if (tok?.access_token) {
        const [movies, anime] = await Promise.all([
          simklUtils.getSimklRatings(tok.access_token, 'movies', since),
          simklUtils.getSimklRatings(tok.access_token, 'anime', since),
        ]);
        const norm = [...imp.fromSimklRatings(movies), ...imp.fromSimklRatings(anime)];
        lists.push(norm);
        perSource.simkl = norm.length;
      }
    } catch (e: any) { logger.warn(`Simkl ratings fetch failed: ${e.message}`); }
  }

  const mdblistKey = config?.apiKeys?.mdblist;
  if (mdblistKey) {
    try {
      const norm = imp.fromMovieRatingItems(await mdbList.getRatingsFromMDBList(mdblistKey, since));
      lists.push(norm);
      perSource.mdblist = norm.length;
    } catch (e: any) { logger.warn(`MDBList ratings fetch failed: ${e.message}`); }
  }

  return { merged: imp.mergeRatings(...lists), perSource };
}

async function syncMovieLensAccount(config: any, opts: { full?: boolean; cooldownSeconds?: number } = {}): Promise<any> {
  const credId = config?.apiKeys?.movieLensCredId;
  if (!credId) return { ok: false, reason: 'not-connected' };

  const cursor = (await getCursor(credId)) || {};

  if (opts.cooldownSeconds && cursor.lastSyncAt) {
    const elapsed = (Date.now() - new Date(cursor.lastSyncAt).getTime()) / 1000;
    if (elapsed < opts.cooldownSeconds) {
      return { ok: false, reason: 'cooldown', nextAllowedInSeconds: Math.ceil(opts.cooldownSeconds - elapsed) };
    }
  }

  const since = opts.full ? undefined : cursor.lastSyncAt;

  const { merged, perSource } = await gatherRatings(config, since);
  if (!merged.length) {
    if (!opts.full) await setCursor(credId, { ...cursor, lastSyncAt: new Date().toISOString() });
    return { ok: true, imported: 0, perSource, note: 'no new ratings' };
  }

  const { csv, count } = imp.normalizedToImdbCsv(merged);
  const result = await movielens.importImdbCsv(credId, csv);
  await setCursor(credId, { ...cursor, lastSyncAt: new Date().toISOString() });

  const rejected = Number.isFinite(result.errorCount) ? `, ${result.errorCount} rejected` : '';
  logger.info(
    `Synced ${credId}: sent ${count} ratings, MovieLens reports ${result.successCount} new, ` +
    `${result.alreadyRatedCount} already rated${rejected}`
  );
  return { ok: true, sent: count, ...result, perSource };
}

async function bootstrapMovieLensAccount(config: any): Promise<any> {
  return syncMovieLensAccount(config, { full: true });
}

async function syncAllMovieLensAccounts(): Promise<{ processed: number; synced: number }> {
  const uuids: string[] = await database.getAllUserUUIDs();
  let processed = 0;
  let synced = 0;
  for (const uuid of uuids) {
    try {
      const raw = await database.getUserConfig(uuid);
      const config = raw?.config_data ? JSON.parse(raw.config_data) : raw;
      if (!config?.apiKeys?.movieLensCredId) continue;
      processed++;
      const res = await syncMovieLensAccount(config, { full: false });
      if (res.ok && (res.successCount || 0) > 0) synced++;
    } catch (e: any) {
      logger.warn(`MovieLens sync failed for ${uuid}: ${e.message}`);
    }
  }
  logger.info(`MovieLens re-sync pass: ${processed} accounts checked, ${synced} received new ratings`);
  return { processed, synced };
}

export {
  gatherRatings,
  syncMovieLensAccount,
  bootstrapMovieLensAccount,
  syncAllMovieLensAccounts,
};
module.exports = {
  gatherRatings,
  syncMovieLensAccount,
  bootstrapMovieLensAccount,
  syncAllMovieLensAccounts,
};
