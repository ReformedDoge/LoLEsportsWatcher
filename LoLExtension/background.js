importScripts('helpers.js');
importScripts('providers/official.js');
importScripts('providers/gql.js');
importScripts('providers/thirdparty.js');
importScripts('leagues/tiers.js');

const MATCH_WINDOW = 900 * 1000;
const PROVIDER_TWITCH = 'twitch';
const PROVIDER_YOUTUBE = 'youtube';

let leagueList = null;
let lastScheduleData = null;
let leagueIdNameMap = {};

initStats();
initDebugMode();
initLeagueIdNameMap();
initGqlTable();

// Persisted-query table: operation name -> {hash, seen}.
let gqlTable = null;
let gqlScannedChunks = null;

async function initGqlTable() {
    try {
        const stored = await chrome.storage.local.get(['gqlTable', 'gqlScannedChunks']);
        gqlTable = stored.gqlTable || null;
        gqlScannedChunks = new Set(stored.gqlScannedChunks || []);
        if (!gqlTable) {
            const res = await fetch(chrome.runtime.getURL('data/gql-ops.json'));
            const bundle = await res.json();
            gqlTable = { version: bundle.version, client: bundle.client || null, ops: {} };
            for (const [name, op] of Object.entries(bundle.ops || {})) {
                gqlTable.ops[name] = { hash: op.hash, seen: false, seenAt: null };
            }
            await chrome.storage.local.set({ gqlTable });
            debugLog(`initGqlTable: seeded ${Object.keys(gqlTable.ops).length} ops from bundle v${bundle.version}`);
        } else {
            const res = await fetch(chrome.runtime.getURL('data/gql-ops.json'));
            const bundle = await res.json();
            if (bundle.version !== gqlTable.version) {
                let added = 0;
                for (const [name, op] of Object.entries(bundle.ops || {})) {
                    if (!gqlTable.ops[name]) {
                        gqlTable.ops[name] = { hash: op.hash, seen: false, seenAt: null };
                        added++;
                    }
                }
                gqlTable.version = bundle.version;
                if (bundle.client) gqlTable.client = bundle.client;
                await chrome.storage.local.set({ gqlTable });
                debugLog(`initGqlTable: bundle v${bundle.version}, added ${added} missing ops`);
            }
        }
    } catch (e) {
        console.warn('initGqlTable failed:', e);
    }
}

function extractIdsFromJs(js) {
    const found = {};
    let m;
    const re1 = /\{[^{}]{0,200}?\bname\s*:\s*"([A-Za-z_]\w*)"[^{}]{0,200}?\bid\s*:\s*"([a-f0-9]{64})"[^{}]*?\}/g;
    while ((m = re1.exec(js))) found[m[1]] = m[2];
    const re2 = /\{[^{}]{0,200}?\bid\s*:\s*"([a-f0-9]{64})"[^{}]{0,200}?\bname\s*:\s*"([A-Za-z_]\w*)"[^{}]*?\}/g;
    while ((m = re2.exec(js))) found[m[2]] = m[1];
    const re3 = /"([A-Z][A-Za-z0-9_]{2,60})"\s*:\s*"([a-f0-9]{64})"/g;
    while ((m = re3.exec(js))) { if (!(m[1] in found)) found[m[1]] = m[2]; }
    return found;
}

async function gqlNotify(detail) {
    await chrome.storage.local.set({ gqlDrift: { at: Date.now(), detail } });
    console.warn(`[GQL drift] ${detail}`);
    if (await getFromLocalStorage('gqlAlerts', false)) {
        debugLog(`[GQL] API drift detected: ${detail}`);
    }
}

async function mergeGqlPairs(pairs, source) {
    if (!gqlTable) await initGqlTable();
    if (!gqlTable) return;
    let changed = false;
    const manifestWins = source === 'manifest';
    for (const [op, hash] of Object.entries(pairs || {})) {
        if (!/^[a-f0-9]{64}$/.test(hash || '')) continue;
        const cur = gqlTable.ops[op];
        if (!cur) {
            gqlTable.ops[op] = { hash, seen: true, seenAt: Date.now() };
            changed = true;
        } else if (cur.hash !== hash) {
            if (!cur.seen) {
                cur.hash = hash; cur.seen = true; cur.seenAt = Date.now();
                changed = true;
            } else if (manifestWins) {
                cur.hash = hash; cur.seenAt = Date.now();
                changed = true;
                gqlNotify(`hash changed for ${op} (manifest): ${cur.hash.slice(0, 12)} -> ${hash.slice(0, 12)}`);
            } else {
                gqlNotify(`hash drift suspected for ${op}: stored ${cur.hash.slice(0, 12)} vs wire ${hash.slice(0, 12)} (awaiting manifest scan)`);
            }
        } else if (!cur.seen) {
            cur.seen = true; cur.seenAt = Date.now();
            changed = true;
        }
    }
    if (changed) await chrome.storage.local.set({ gqlTable });
}

async function scanGqlChunks(urls) {
    if (!gqlTable) await initGqlTable();
    const fresh = (urls || []).filter(u => u && !gqlScannedChunks.has(u)).slice(0, 40);
    if (!fresh.length) return;
    for (const u of fresh) gqlScannedChunks.add(u);
    if (gqlScannedChunks.size > 400) {
        gqlScannedChunks = new Set([...gqlScannedChunks].slice(-200));
    }
    await chrome.storage.local.set({ gqlScannedChunks: [...gqlScannedChunks] });
    let manifestPairs = {};
    let manifestCount = 0;
    for (const u of fresh) {
        try {
            const res = await fetch(u);
            if (!res.ok) continue;
            const text = await res.text();
            if (text.length > 2500000) continue;
            const found = extractIdsFromJs(text);
            const n = Object.keys(found).length;
            if (n >= 10) { manifestCount++; Object.assign(manifestPairs, found); }
        } catch (e) {}
    }
    if (manifestCount) {
        debugLog(`scanGqlChunks: manifest entries from ${manifestCount} chunk(s)`);
        await mergeGqlPairs(manifestPairs, 'manifest');
    }
}

async function getLeagueWindowMap() {
    return await getFromLocalStorage('leagueWindowMap', {});
}

async function setLeagueWindowMap(map) {
    await chrome.storage.local.set({ leagueWindowMap: map });
}

const isLeagueExcluded = async (leagueName) => {
    const excludedLeagues = (await getFromLocalStorage('excludedLeagues')) || [];
    return excludedLeagues.includes(leagueName) || excludedLeagues.includes(resolveLeagueName(leagueName));
};

async function verifyLeagueWindowURL(leagueName, windowID) {
    const matchLeagueURL = leagueList?.[leagueName];
    if (!matchLeagueURL) return;

    const tab = await getTab(windowID);
    if (!tab || !tab.url) return;

    try {
        const expectedPath = new URL(matchLeagueURL).pathname.replace(/\/+$/, '');
        const currentPath = new URL(tab.url).pathname.replace(/\/+$/, '');
        if (!currentPath.includes(expectedPath)) {
            debugLog(`verifyLeagueWindowURL: ${leagueName} tab mismatch (expected ${expectedPath}, got ${currentPath}), correcting...`);
            const url = await streamURL(matchLeagueURL, leagueName);
            await updateTabURL(windowID, url);
        }
    } catch (e) {
        console.warn(`verifyLeagueWindowURL failed for ${leagueName}:`, e);
    }
}

async function restoreMissingWindows() {
    let leagueWindowMap = await getLeagueWindowMap();
    const updatedMap = { ...leagueWindowMap };
    let needsUpdate = false;
    debugLog(`restoreMissingWindows: ${Object.keys(leagueWindowMap).length} tracked windows`);

    for (const [leagueName, leagueWindow] of Object.entries(leagueWindowMap)) {
        const { windowID, matchIDs } = leagueWindow;

        if (!windowID || typeof windowID !== "number") {
            console.warn(`Invalid windowID for ${leagueName}, reopening...`);
            const newWindow = await reopenLeagueWindow(leagueName, matchIDs);
            if (newWindow) {
                updatedMap[leagueName].windowID = newWindow.id;
                needsUpdate = true;
            }
            continue;
        }

        try {
            await chrome.windows.get(windowID);
            await verifyLeagueWindowURL(leagueName, windowID);
        } catch (error) {
            console.warn(`Window for ${leagueName} is missing. Reopening...`);
            const newWindow = await reopenLeagueWindow(leagueName, matchIDs);
            if (newWindow) {
                leagueWindowMap[leagueName] = {
                    matchIDs: matchIDs,
                    windowID: newWindow.id
                };
                debugLog(`Reopened window ${newWindow.id} for ${leagueName}`);
            }
        }
    }

    if (needsUpdate) {
        await setLeagueWindowMap(updatedMap);
    }
}

async function reopenLeagueWindow(leagueName, matchIDs) {
    const provider = await getCurrentProvider();
    let matchLeagueURL = leagueList?.[leagueName];
    if (!matchLeagueURL) {
        const leagues = await provider.getLeagues();
        matchLeagueURL = leagues[leagueName];
    }

    if (!matchLeagueURL) {
        console.warn(`No valid URL found for league: ${leagueName}`);
        return null;
    }

    const url = await streamURL(matchLeagueURL, leagueName);
    const windowState = await getFromLocalStorage('windowState', 'normal');

    try {
        const newWindow = await createWindow(url, windowState);
        debugLog(`Reopened window for ${leagueName} with new ID: ${newWindow.id}`);

        let leagueWindowMap = await getLeagueWindowMap();
        leagueWindowMap[leagueName] = { matchIDs, windowID: newWindow.id };
        await setLeagueWindowMap(leagueWindowMap);

        return newWindow;
    } catch (error) {
        console.error(`Failed to reopen window for ${leagueName}:`, error);
        return null;
    }
}

async function initLeagueIdNameMap() {
    try {
        const s = await chrome.storage.session.get('leagueIdNameMap');
        leagueIdNameMap = s.leagueIdNameMap || {};
        debugLog(`initLeagueIdNameMap: ${Object.keys(leagueIdNameMap).length} league IDs loaded`);
    } catch(e) {
        leagueIdNameMap = {};
    }
}

async function persistLeagueIdNameMap() {
    try {
        await chrome.storage.session.set({ leagueIdNameMap });
    } catch(e) {}
}

const fetchSchedule = async () => {
    const provider = await getCurrentProvider();
    debugLog(`fetchSchedule: provider=${provider.id}`);
    const data = await provider.getSchedule();
    stats.lastPollTime = new Date().toISOString();
    chrome.storage.session.set({ requestStats: stats }).catch(() => {});
    lastScheduleData = data;

    if (data?.data?.schedule?.events) {
        debugLog(`fetchSchedule: ${data.data.schedule.events.length} events received`);
        for (const event of data.data.schedule.events) {
            if (event.league?.id && event.league?.name) {
                const id = String(event.league.id);
                if (!leagueIdNameMap[id]) {
                    leagueIdNameMap[id] = event.league.name.trim();
                }
            }
        }
        persistLeagueIdNameMap();
        debugLog(`leagueIdNameMap: ${Object.keys(leagueIdNameMap).length} IDs`);
    } else {
        debugLog('fetchSchedule: no events in response');
    }

    await checkSchedule(data);
    const status = await computeLeagueStatus();
    chrome.storage.local.set({ _leagueStatus: status, _leagueStatusUpdated: Date.now() }).catch(() => {});

    const allLeagueNames = getAllLeagueNames();
    const providerLeagues = leagueList ? Object.keys(leagueList) : [];
    const mergedSet = new Set([...allLeagueNames, ...providerLeagues]);
    const rawExcluded = await getFromLocalStorage('excludedLeagues', []);
    const excluded = rawExcluded.filter(name => mergedSet.has(name));
    const liveCount = Object.values(status).filter(s => s.state === 'live').length;
    const upcomingCount = Object.values(status).filter(s => s.state === 'upcoming').length;
    chrome.storage.local.set({
      _statsData: {
        requestStats: getRequestStats(),
        leagues: {
          total: mergedSet.size,
          tierCount: allLeagueNames.length,
          excluded: excluded.length,
          active: mergedSet.size - excluded.length,
          live: liveCount,
          upcoming: upcomingCount,
          scheduleEvents: data?.data?.schedule?.events?.length || 0
        },
        allLeagueNames: [...mergedSet]
      }
    }).catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 500));
    await restoreMissingWindows();
};

const fetchLeagues = async () => {
    const provider = await getCurrentProvider();
    const data = await provider.getLeagues();
    if (data) {
        debugLog(`fetchLeagues: ${Object.keys(data).length} leagues mapped`);
        if (provider?._leagueIdNameMap) {
            let added = 0;
            for (const [id, name] of Object.entries(provider._leagueIdNameMap)) {
                if (!leagueIdNameMap[id]) {
                    leagueIdNameMap[id] = name;
                    added++;
                }
            }
            if (added > 0) {
                persistLeagueIdNameMap();
                debugLog(`leagueIdNameMap: added ${added} league IDs from getLeagues (total ${Object.keys(leagueIdNameMap).length})`);
            }
        }
    }
    return data;
};

const fetchStreams = async (leagueName) => {
    const provider = await getCurrentProvider();
    const result = await provider.getStreams(leagueName);
    debugLog(`fetchStreams(${leagueName}): ${result.streams.length} streams, hasStreams=${result.hasStreams}`);
    return result;
};

async function checkSchedule(data) {
    if (!data?.data?.schedule?.events) {
        debugLog('checkSchedule: no events, skipping');
        return;
    }

    debugLog('checkSchedule: processing events...');
    const events = data.data.schedule.events;
    const date = new Date();
    const timeNow = new Date().toLocaleString();
    leagueList = await fetchLeagues();
    let leagueWindowMap = await getLeagueWindowMap();
    let processed = 0, opened = 0, completed = 0;
    const openDuringBroadcast = await getFromLocalStorage('openDuringBroadcast', false);

    const hasActiveEvent = (leagueName) => events.some(e =>
        e.league.name.trim() === leagueName &&
        e.state !== 'completed' &&
        (e.state === 'inProgress' ||
         (e.state === 'unstarted' && new Date(e.startTime) - date <= MATCH_WINDOW))
    );

    for (const event of events) {
        const leagueName = event.league.name.trim();
        const matchID = event?.match?.id;
        const timeUntilMatch = new Date(event.startTime) - date;

        debugLog(`  ${event.type}: ${leagueName} ${matchID ? `match=${matchID}` : ''}state=${event.state} starts=${event.startTime} timeUntil=${Math.round(timeUntilMatch/1000)}s`);

        if (await isLeagueExcluded(leagueName)) {
            debugLog(`    -> excluded, skipping`);
            continue;
        }

        if (event?.state === 'unstarted' || (event?.state === 'inProgress' && (event?.type === 'match' || (openDuringBroadcast && event.type !== 'match')))) {
            if (
                timeUntilMatch <= MATCH_WINDOW ||
                (event?.state === 'inProgress' && leagueWindowMap[leagueName]) ||
                (event?.state === 'inProgress' && !leagueWindowMap[leagueName])
            ) {
                if (leagueWindowMap[leagueName] && matchID && !leagueWindowMap[leagueName].matchIDs.includes(matchID)) {
                    const wasEmpty = leagueWindowMap[leagueName].matchIDs.length === 0;
                    leagueWindowMap[leagueName].matchIDs.push(matchID);
                    debugLog(`    -> added match ${matchID} to existing window for ${leagueName}${wasEmpty ? ' (broadcast->match transition)' : ''}`);
                    await verifyLeagueWindowURL(leagueName, leagueWindowMap[leagueName].windowID);
                } else if (leagueWindowMap[leagueName]) {
                    await verifyLeagueWindowURL(leagueName, leagueWindowMap[leagueName].windowID);
                } else if (!leagueWindowMap[leagueName]) {
                    let hasStreams;
                    if (matchID) {
                        const result = await fetchStreams(leagueName);
                        hasStreams = result.hasStreams;
                    } else {
                        hasStreams = !!leagueList?.[leagueName];
                    }
                    if (hasStreams) {
                        const matchLeagueURL = leagueList[leagueName];
                        if (!matchLeagueURL) {
                            console.warn(`No valid URL found for league: ${leagueName}`);
                            continue;
                        }
                        const newWindow = await openWindowForLeague(matchLeagueURL, leagueName, matchID, timeNow);
                        if (newWindow) {
                            leagueWindowMap[leagueName] = {
                                matchIDs: matchID ? [matchID] : [],
                                windowID: newWindow.id
                            };
                            opened++;
                            debugLog(`    -> opened new window ${newWindow.id} for ${matchID ? 'match' : 'broadcast'} ${leagueName}${matchID ? ` (${matchID})` : ''}`);
                        }
                    } else {
                        debugLog(`    -> no streams available for ${leagueName}`);
                    }
                }
            } else {
                debugLog(`    -> outside match window (${Math.round(timeUntilMatch/1000)}s > ${MATCH_WINDOW/1000}s)`);
            }
            processed++;
        } else if (event?.state === 'completed') {
            if (leagueWindowMap[leagueName] && matchID && leagueWindowMap[leagueName].matchIDs.includes(matchID)) {
                leagueWindowMap[leagueName].matchIDs = leagueWindowMap[leagueName].matchIDs.filter(id => id !== matchID);
                debugLog(`    -> match ${matchID} completed, removed from ${leagueName}`);
            }

            if (leagueWindowMap[leagueName] && leagueWindowMap[leagueName].matchIDs.length === 0) {
                if (hasActiveEvent(leagueName)) {
                    debugLog(`    -> keeping window open for ${leagueName} (active event still present)`);
                } else {
                    debugLog(`    -> closing window for ${leagueName} (no more events)`);
                    try {
                        await chrome.windows.remove(leagueWindowMap[leagueName].windowID);
                        completed++;
                    } catch (error) {
                        console.warn(`Failed to close window ${leagueWindowMap[leagueName].windowID}, it may have been already closed.`);
                    }
                    delete leagueWindowMap[leagueName];
                }
            }
        }
    }

    debugLog(`checkSchedule done: ${processed} processed, ${opened} opened, ${completed} closed`);

    await setLeagueWindowMap(leagueWindowMap);
    await checkURL();
}

async function computeLeagueStatus() {
    const status = {};
    if (!lastScheduleData?.data?.schedule?.events) {
        debugLog('computeLeagueStatus: no schedule data');
        return status;
    }
    if (!leagueList) {
        debugLog('computeLeagueStatus: no leagueList');
        return status;
    }

    const openDuringBroadcast = await getFromLocalStorage('openDuringBroadcast', false);

    for (const event of lastScheduleData.data.schedule.events) {
        const rawName = event.league.name.trim();
        const leagueName = resolveLeagueName(rawName);
        if (!status[leagueName]) {
            status[leagueName] = { state: null, startTime: null, url: leagueList[rawName] || leagueList[leagueName] };
        }

        if (event.state === 'inProgress' && (event.type === 'match' || (openDuringBroadcast && event.type !== 'match'))) {
            status[leagueName].state = 'live';
            status[leagueName].startTime = event.startTime;
        } else if (event.state === 'unstarted' && !status[leagueName].state) {
            if (!status[leagueName].state || event.startTime < status[leagueName].startTime) {
                status[leagueName].state = 'upcoming';
                status[leagueName].startTime = event.startTime;
            }
        }
    }

    debugLog(`computeLeagueStatus: ${Object.keys(status).length} leagues, ${Object.values(status).filter(s=>s.state==='live').length} live`);
    return status;
}

async function reconfigureAlarm() {
    const interval = await getFromLocalStorage('pollInterval', 3);
    chrome.alarms.clear('fetchSchedule', () => {
        chrome.alarms.create('fetchSchedule', { periodInMinutes: interval });
        debugLog(`Alarm reconfigured to ${interval} minutes`);
    });
}

// dev bridge can dispatch into the exact same handlers the popup uses
function handleExtensionAction(message, sender, sendResponse) {
    if (message.action !== 'gqlSeen' || message.kind !== 'LOL_WATCHER_GQL_CHUNKS') {
        debugLog(`onMessage: ${message.action}`, message);
    }

    if (message.action === "togglePlayerRemoval") {
        debugLog(`Player Removal ${message.enabled ? "ENABLED" : "DISABLED"}`);
        chrome.storage.local.set({ removePlayerEnabled: message.enabled });

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, { action: "togglePlayerRemoval", enabled: message.enabled });
            }
        });
    }

    if (message.action === "switchProvider") {
        const provider = getProvider(message.providerId);
        if (provider) {
            if (provider.id === PROVIDER_OFFICIAL) {
                provider.clearCache();
                debugLog('Cleared official provider cache');
            }
            debugLog(`Switched provider to ${provider.name}`);
            sendResponse({ success: true, provider: provider.name });
        } else {
            sendResponse({ success: false, error: 'Provider not found' });
        }
        return true;
    }

    if (message.action === "getProviders") {
        const safeProviders = getAllProviders().map(p => ({ id: p.id, name: p.name }));
        sendResponse({ providers: safeProviders });
        return true;
    }

    if (message.action === "getPopupData") {
        (async () => {
        const providerId = message.providerId || 'official';
        const provider = getProvider(providerId);
        const leagueStatus = await computeLeagueStatus();
        sendResponse({
            providerName: provider ? provider.name : 'Unknown',
            providerId: providerId,
            leagueStatus: leagueStatus,
            leagueList: leagueList || {},
            pollInterval: message.pollInterval || 3,
            debugMode: _debugMode
        });
        })();
        return true;
    }

    if (message.action === "testGqlHashes") {
        (async () => {
            const stored = await chrome.storage.local.get(['gqlTable']);
            const ops = stored.gqlTable?.ops || {};
            const table = {};
            for (const [name, op] of Object.entries(ops)) {
                table[name] = `${(op.hash || '?').slice(0, 12)} seen=${!!op.seen}`;
            }
            const probe = { chunksScanned: 0, manifestUrl: null, manifestOps: 0, found: {} };
            try {
                const pages = ['https://lolesports.com/en-GB/live/worlds', 'https://lolesports.com/en-GB/rewards'];
                const urls = [];
                for (const p of pages) {
                    const html = await (await fetch(p)).text();
                    for (const m of html.matchAll(/\/_next\/static\/chunks\/([a-zA-Z0-9._-]+\.js)/g)) {
                        const u = 'https://lolesports.com/_next/static/chunks/' + m[1];
                        if (!urls.includes(u)) urls.push(u);
                    }
                    if (urls.length >= 15) break;
                }
                for (const u of urls.slice(0, 15)) {
                    let js = null;
                    try {
                        const res = await fetch(u);
                        if (!res.ok) continue;
                        js = await res.text();
                        if (js.length > 1500000) continue;
                    } catch (e) { continue; }
                    probe.chunksScanned++;
                    if (!js.includes('apollo-persisted-query-manifest')) continue;
                    const pairs = extractIdsFromJs(js);
                    if (Object.keys(pairs).length >= 10) {
                        probe.manifestUrl = u.split('/').pop();
                        probe.manifestOps = Object.keys(pairs).length;
                        probe.found = pairs;
                        break;
                    }
                }
            } catch (e) {
                probe.error = String((e && e.message) || e);
            }
            const compare = {};
            for (const [name, op] of Object.entries(ops)) {
                if (probe.found[name]) {
                    compare[name] = probe.found[name] === op.hash ? 'match' : `MISMATCH table=${op.hash.slice(0, 12)} manifest=${probe.found[name].slice(0, 12)}`;
                } else {
                    compare[name] = op.seen ? 'table-only (wire-confirmed)' : 'table-only (unconfirmed)';
                }
            }
            for (const name of Object.keys(probe.found)) {
                if (!ops[name]) compare[name] = 'manifest-only (new op)';
            }
            sendResponse({ table, probe: { chunksScanned: probe.chunksScanned, manifestUrl: probe.manifestUrl, manifestOps: probe.manifestOps, error: probe.error || null }, compare });
        })();
        return true;
    }

    if (message.action === "compareProviders") {
        (async () => {
            const out = {};
            for (const pid of ['official', 'gql', 'thirdparty']) {
                const p = getProvider(pid);
                if (!p) { out[pid] = { error: 'missing' }; continue; }
                const t0 = Date.now();
                try {
                    if (p.clearCache) p.clearCache();
                    const sched = await p.getSchedule();
                    const events = sched?.data?.schedule?.events || [];
                    const states = {};
                    for (const e of events) states[e.state] = (states[e.state] || 0) + 1;
                    const leagues = await p.getLeagues();
                    const s0 = events.find(e => e.state === 'inProgress');
                    out[pid] = {
                        ms: Date.now() - t0,
                        events: events.length,
                        states,
                        leagues: Object.keys(leagues).length,
                        liveSample: s0 ? { league: s0.league?.name, match: !!s0.match?.id, streams: s0.streams?.length } : null
                    };
                } catch (e) { out[pid] = { error: String((e && e.message) || e) }; }
            }
            sendResponse(out);
        })();
        return true;
    }

    if (message.action === "testEventDetails") {
        (async () => {
            const provider = await getCurrentProvider();
            provider.clearCache();
            const status = await computeLeagueStatus();
            const live = Object.entries(status).find(([_, s]) => s.state === 'live');
            const leagueName = live ? live[0] : 'Worlds';
            const result = await fetchStreams(leagueName);
            sendResponse({ success: true, league: leagueName,
                streams: result.streams.length, hasStreams: result.hasStreams,
                providers: [...new Set(result.streams.map(s => s.provider))] });
        })();
        return true;
    }

    if (message.action === "forceRefresh") {
        debugLog('forceRefresh requested');
        fetchSchedule().then(() => {
            debugLog('forceRefresh completed');
            sendResponse({ success: true });
        }).catch((err) => {
            console.error('forceRefresh failed:', err);
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }

    if (message.action === "getStats") {
        (async () => {
        if (!stats) await initStats();
        const allLeagueNames = getAllLeagueNames();
        const providerLeagues = leagueList ? Object.keys(leagueList) : [];
        const mergedSet = new Set([...allLeagueNames, ...providerLeagues]);
        const mergedNames = [...mergedSet];
        const rawExcluded = await getFromLocalStorage('excludedLeagues', []);
        const excluded = rawExcluded.filter(name => mergedSet.has(name));
        const leagueStatus = await computeLeagueStatus();
            const liveCount = Object.values(leagueStatus).filter(s => s.state === 'live').length;
            const upcomingCount = Object.values(leagueStatus).filter(s => s.state === 'upcoming').length;
            const scheduleEvents = lastScheduleData?.data?.schedule?.events?.length || 0;
            const total = mergedSet.size;

            debugLog(`getStats: total=${total} (tiers=${allLeagueNames.length} provider=${providerLeagues.length}) excluded=${excluded.length} live=${liveCount} upcoming=${upcomingCount} scheduleEvents=${scheduleEvents}`);

            sendResponse({
                requestStats: getRequestStats(),
                leagues: {
                    total: total,
                    tierCount: allLeagueNames.length,
                    excluded: excluded.length,
                    active: total - excluded.length,
                    live: liveCount,
                    upcoming: upcomingCount,
                    scheduleEvents
                },
                allLeagueNames: mergedNames
            });
        })();
        return true;
    }

    if (message.action === "updatePollInterval") {
        chrome.storage.local.set({ pollInterval: message.interval }, () => {
            reconfigureAlarm();
            debugLog(`Poll interval updated to ${message.interval}m`);
            sendResponse({ success: true });
        });
        return true;
    }

    if (message.action === "setDebugMode") {
        _debugMode = !!message.enabled;
        chrome.storage.local.set({ debugMode: _debugMode }, () => {
            debugLog(`Debug mode ${_debugMode ? 'ENABLED' : 'DISABLED'}`);
            sendResponse({ success: true, debugMode: _debugMode });
        });
        return true;
    }

    if (message.action === "resolveLeagueName" && message.leagueID) {
        (async () => {
            let leagueName = leagueIdNameMap[String(message.leagueID)] || null;
            if (!leagueName && lastScheduleData?.data?.schedule?.events) {
                for (const event of lastScheduleData.data.schedule.events) {
                    if (String(event.league?.id) === String(message.leagueID)) {
                        leagueName = event.league.name?.trim();
                        if (leagueName) {
                            leagueIdNameMap[String(message.leagueID)] = leagueName;
                            persistLeagueIdNameMap();
                        }
                        break;
                    }
                }
            }
            if (!leagueName) {
                const provider = await getCurrentProvider();
                await provider.getLeagues();
                leagueName = provider._leagueIdNameMap?.[String(message.leagueID)] || null;
                if (leagueName) {
                    leagueIdNameMap[String(message.leagueID)] = leagueName;
                    persistLeagueIdNameMap();
                }
            }
            debugLog(`resolveLeagueName: ${message.leagueID} -> ${leagueName || '(not found)'}`);
            sendResponse({ leagueName });
        })();
        return true;
    }

    if (message.action === "gqlSeen") {
        (async () => {
            if (message.kind === 'LOL_WATCHER_GQL_SEEN') {
                await mergeGqlPairs(message.payload, 'wire');
            } else if (message.kind === 'LOL_WATCHER_GQL_CHUNKS') {
                await scanGqlChunks(message.payload);
            } else if (message.kind === 'LOL_WATCHER_GQL_ERROR') {
                const detail = `gql error op=${message.payload?.op || '?'} status=${message.payload?.status || '?'}`;
                debugLog(`[GQL] ${detail}`);
                await chrome.storage.local.set({ gqlDrift: { at: Date.now(), detail } });
            }
        })();
        return false;
    }

    if (message.action === "rmsEvent") {
        const data = message.data || {};
        debugLog(`[RMS] ${message.ev} ${JSON.stringify(data)}`);
        bridgeEvent('rms', { ev: message.ev, ...data, page: sender?.tab ? (sender.tab.url || '').replace(/^https:\/\/lolesports\.com/, '') : null });
    }

    if (message.action === "log") {
        debugLog(`[Content] ${message.message}`);
        bridgeEvent('log', { msg: message.message, page: sender?.tab ? (sender.tab.url || '').replace(/^https:\/\/lolesports\.com/, '') : null });
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleExtensionAction(message, sender, sendResponse);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
    let leagueWindowMap = await getLeagueWindowMap();

    for (const leagueName in leagueWindowMap) {
        if (leagueWindowMap[leagueName].windowID === windowId) {
            delete leagueWindowMap[leagueName];
            debugLog(`Window ${windowId} closed by user for ${leagueName}`);
            await setLeagueWindowMap(leagueWindowMap);
            break;
        }
    }
});

async function createWindow(url, state) {
    try {
        const window = await new Promise((resolve, reject) => {
            chrome.windows.create({ url, state }, (window) => {
                if (chrome.runtime.lastError || !window) {
                    reject(`Failed to create window: ${chrome.runtime.lastError?.message}`);
                } else {
                    resolve(window);
                }
            });
        });
        // Stream tabs run for hours unattended, opt out of automatic discard.
        try {
            const tabs = await new Promise((resolve) => {
                chrome.tabs.query({ windowId: window.id }, resolve);
            });
            for (const tab of tabs || []) {
                if (tab.url && !tab.url.startsWith('opera:') && !tab.url.startsWith('chrome:')) {
                    chrome.tabs.update(tab.id, { autoDiscardable: false }, () => {
                        if (!chrome.runtime.lastError) debugLog(`Tab ${tab.id} marked non-discardable`);
                    });
                }
            }
        } catch (e) {}
        return window;
    } catch (error) {
        console.error("Error creating window:", error);
    }
}

function replaceURL(url, parameter) {
    let urlObj = new URL(url);
    let pathnames = urlObj.pathname.split('/').filter(Boolean);
    let liveIndex = pathnames.indexOf("live");

    if (liveIndex !== -1) {
        let afterLive = pathnames.slice(liveIndex + 1);
        if (afterLive.length === 1) {
            pathnames.push(parameter);
        } else {
            pathnames[pathnames.length - 1] = parameter;
        }
        urlObj.pathname = "/" + pathnames.join('/');
    }

    debugLog(`replaceURL: ${url} -> ${urlObj.toString()}`);
    return urlObj.toString();
}

const streamURL = async (matchURL, leagueName, matchID = null) => {
    const provider = await getFromLocalStorage('provider', PROVIDER_TWITCH);

    if (provider) {
        const resolved = await resolveStreamUrl(matchURL, leagueName, matchID, provider);
        if (resolved) return resolved;
        debugLog(`streamURL(${leagueName}): no ${provider} stream resolved, using base URL`);
        return matchURL;
    }

    const { streams } = await fetchStreams(leagueName);
    const youtubeStream = streams.find((stream) => stream.provider === PROVIDER_YOUTUBE);
    const twitchStream = streams.find((stream) => stream.provider === PROVIDER_TWITCH);

    let streamId;

    if (provider === PROVIDER_YOUTUBE) {
        streamId = youtubeStream?.parameter || twitchStream?.parameter;
    } else {
        streamId = twitchStream?.parameter || youtubeStream?.parameter;
    }

    if (!streamId) {
        console.warn(`No valid stream found for ${leagueName}, using given matchURL.`);
        debugLog(`streamURL(${leagueName}): no stream found, using raw URL`);
        return matchURL;
    }

    debugLog(`streamURL(${leagueName}): using ${provider} stream ${streamId}`);
    return replaceURL(matchURL, streamId);
};

// Resolve an explicit provider stream URL via watchLiveQuery, whose stream
// ids are the page URL ids. Falls back to null (caller keeps base URL).
async function resolveStreamUrl(matchURL, leagueName, matchID, provider) {
    try {
        const stored = await chrome.storage.local.get(['gqlTable']);
        const table = stored.gqlTable?.ops || {};
        const hash = table.watchLiveQuery?.hash;
        if (!hash) return null;
        const params = new URLSearchParams({
            operationName: 'watchLiveQuery',
            variables: JSON.stringify({ hl: 'en-GB', sport: ['lol'], eventState: ['inProgress'], pageSize: 50 }),
            extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } })
        });
        const res = await fetch(`${GQL_API_BASE}?${params.toString()}`, {
            headers: {
                'x-api-key': OFFICIAL_API_KEY,
                'apollo-require-preflight': 'true',
                'apollographql-client-name': 'Esports Web',
                'apollographql-client-version': (stored.gqlTable?.client?.version || '1f05c07')
            }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const events = data?.data?.esports?.events || [];
        const event = events.find(e => e.match?.id === matchID && e.league?.name?.trim() === leagueName)
            || events.find(e => e.league?.name?.trim() === leagueName);
        const streams = event?.streams || [];
        if (!streams.length) return null;
        const chain = [provider, ...['twitch', 'youtube', 'afreecatv', 'trovo'].filter(p => p !== provider)];
        for (const p of chain) {
            const pool = streams.filter(s => s.provider === p);
            if (!pool.length) continue;
            const pick = pool.find(s => (s.mediaLocale?.locale || '').toLowerCase().startsWith('en'))
                || pool[0];
            if (pick?.id) {
                debugLog(`resolveStreamUrl(${leagueName}): ${p} stream ${pick.id} (${pick.mediaLocale?.locale || '?'})`);
                bridgeEvent('stream', { league: leagueName, provider: p, streamId: pick.id, locale: pick.mediaLocale?.locale || null });
                return replaceURL(matchURL, String(pick.id));
            }
        }
    } catch (e) {
        debugLog(`resolveStreamUrl failed: ${(e && e.message) || e}`);
    }
    return null;
}

async function openWindowForLeague(matchURL, leagueName, matchID, timeNow) {
    const windowState = await getFromLocalStorage('windowState', 'normal');
    const url = await streamURL(matchURL, leagueName, matchID);
    const window = await createWindow(url, windowState);
    debugLog(`Opened window ${window.id} for ${leagueName} match ${matchID}`);
    return window;
}

async function checkURL() {
    const preferred = await getFromLocalStorage('provider', PROVIDER_TWITCH);
    if (preferred) {
        debugLog(`checkURL: preferred provider set (${preferred}), inject.js handles stream selection`);
        return;
    }

    let leagueWindowMap = await getLeagueWindowMap();
    debugLog(`checkURL: ${Object.keys(leagueWindowMap).length} windows to check`);

    for (const [leagueName, leagueWindow] of Object.entries(leagueWindowMap)) {
        const { windowID } = leagueWindow;
        let matchLeagueURL = leagueList[leagueName];

        if (!matchLeagueURL) {
            console.warn(`No valid URL found for league: ${leagueName}`);
            continue;
        }

        const { hasStreams } = await fetchStreams(leagueName);
        if (!hasStreams) {
            debugLog(`checkURL: no streams for ${leagueName}, keeping current URL`);
            continue;
        }

        const url = await streamURL(matchLeagueURL, leagueName);
        await updateTabURL(windowID, url);
    }
}

async function getTab(windowId) {
    return new Promise((resolve) => {
        chrome.tabs.query({ windowId }, (tabs) => {
            if (!tabs || !tabs.length) { resolve(null); return; }
            resolve(tabs.find(t => ((t.pendingUrl || t.url) || '').includes('lolesports.com/live')) || tabs[0]);
        });
    });
}

function normalizeURL(url) {
    try {
        let u = new URL(url);
        u.pathname = u.pathname.replace(/\/+$/, '');
        return u.toString();
    } catch {
        return url;
    }
}

async function updateTabURL(windowId, matchURL) {
    const tab = await getTab(windowId);
    if (tab && tab.status === 'complete') {
        const normalizedCurrent = normalizeURL(tab.url);
        const normalizedTarget = normalizeURL(matchURL);
        if (normalizedCurrent !== normalizedTarget) {
            return new Promise((resolve) => {
                chrome.tabs.update(tab.id, { url: matchURL }, () => {
                    if (chrome.runtime.lastError) {
                        debugLog(`updateTabURL: tab ${tab.id} not updated (${chrome.runtime.lastError.message})`);
                    } else {
                        debugLog(`Updated tab ${tab.id} from ${tab.url} to ${matchURL}`);
                    }
                    resolve();
                });
            });
        }
    }
    return tab;
}

chrome.runtime.onInstalled.addListener(async () => {
    debugLog('Extension installed/updated');
    try {
        await reconfigureAlarm();
        await fetchSchedule();
    } catch (error) {
        console.error("Failed to fetch schedule on install:", error);
    }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "fetchSchedule") {
        debugLog('Scheduled poll triggered');
        await fetchSchedule();
    }
});

// Dev bridge: outbound WebSocket RPC for live diagnosis
const DEV_COMMANDS = [
    ['help', 'list bridge commands'],
    ['ping', 'echo liveness'],
    ['get-log', 'recent log ring {n}'],
    ['get-storage', 'storage.local dump {dropsLimit}'],
    ['get-gql', 'gql table + drift state'],
    ['getStats', 'leagues/stats snapshot'],
    ['forceRefresh', 'refetch schedule now'],
    ['testGqlHashes', 'probe persisted-query manifest vs table'],
    ['compareProviders', 'all providers parity snapshot'],
    ['testEventDetails', 'legacy getEventDetails sample'],
    ['setDebugMode', 'toggle debug logging {enabled}'],
    ['list-tabs', 'all tabs with state'],
    ['focus-tab', 'focus a tab {tabId}'],
    ['reload-tab', 'reload a tab {tabId}'],
    ['page-op', 'run a page inspection op {tabId, op, args}'],
    ['fetch-text', 'fetch a lolesports.com file {url, name}'],
];
const DEV_PARITY_ACTIONS = new Set(['getStats', 'getPopupData', 'getProviders', 'forceRefresh', 'testGqlHashes', 'compareProviders', 'testEventDetails', 'setDebugMode', 'updatePollInterval', 'switchProvider']);

const devBridge = { ws: null, connecting: false, backoffMs: 5000, lastError: null, pingTimer: null };

function bridgeEvent(name, data) {
    try {
        if (devBridge.ws && devBridge.ws.readyState === 1) {
            devBridge.ws.send(JSON.stringify({ event: name, ...data }));
        }
    } catch (e) {}
}

function devBridgeTick() {
    if (devBridge.ws || devBridge.connecting) return;
    chrome.storage.local.get(['devBridgeEnabled', 'devBridgeUrl'], (s) => {
        if (!s.devBridgeEnabled) return;
        devBridgeConnect(s.devBridgeUrl || 'ws://127.0.0.1:18790');
    });
}

function devBridgeReconnect() {
    try { devBridge.ws?.close(); } catch (e) {}
    devBridge.ws = null;
    devBridge.backoffMs = 5000;
    devBridgeTick();
}

function devBridgeConnect(url) {
    if (devBridge.ws || devBridge.connecting) return;
    devBridge.connecting = true;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { devBridge.connecting = false; scheduleDevBridgeRetry(); return; }
    devBridge.ws = ws;
    const openTimer = setTimeout(() => { try { ws.close(); } catch (e) {} }, 15000);
    ws.onopen = () => {
        clearTimeout(openTimer);
        devBridge.connecting = false;
        devBridge.backoffMs = 5000;
        devBridge.lastError = null;
        debugLog('dev bridge connected');
        try {
            ws.send(JSON.stringify({ role: 'ext', client: 'lolesports-watcher', commands: DEV_COMMANDS.map(([type, desc]) => ({ type, desc })) }));
        } catch (e) {}
        if (!devBridge.pingTimer) {
            devBridge.pingTimer = setInterval(() => {
                try { if (devBridge.ws && devBridge.ws.readyState === 1) devBridge.ws.send(JSON.stringify({ ping: Date.now() })); } catch (e) {}
            }, 25000);
        }
    };
    ws.onmessage = (m) => { handleDevBridgeFrame(m.data).catch(() => {}); };
    const down = () => {
        clearTimeout(openTimer);
        devBridge.connecting = false;
        if (devBridge.ws === ws) devBridge.ws = null;
        try { ws.close(); } catch (e) {}
        scheduleDevBridgeRetry();
    };
    ws.onclose = down;
    ws.onerror = () => { devBridge.lastError = { ts: Date.now(), msg: 'socket error' }; };
}

function scheduleDevBridgeRetry() {
    const wait = devBridge.backoffMs + Math.floor(Math.random() * 2000);
    devBridge.backoffMs = Math.min(devBridge.backoffMs * 2, 60000);
    setTimeout(() => devBridgeTick(), wait);
}

async function handleDevBridgeFrame(raw) {
    let f;
    try { f = JSON.parse(raw); } catch (e) { return; }
    const ws = devBridge.ws;
    const reply = (obj) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} };
    if (f.hello) return;
    if (f.id == null || !f.type) return;
    const type = f.type;
    if (type === 'ping') { reply({ id: f.id, ok: true, response: { pong: Date.now() } }); return; }
    if (type === 'help') { reply({ id: f.id, ok: true, response: { commands: DEV_COMMANDS } }); return; }
    const known = new Set(DEV_COMMANDS.map(([t]) => t));
    if (!known.has(type)) { reply({ id: f.id, ok: false, error: 'unknown command (try help)' }); return; }

    if (type === 'get-log') {
        const n = Math.min((f.n | 0) || 200, 800);
        const ring = globalThis.__lolLogRing || [];
        reply({ id: f.id, ok: true, response: { count: ring.length, lines: ring.slice(-n) } });
        return;
    }
    if (type === 'get-storage') {
        const all = await chrome.storage.local.get(null);
        const limit = (f.dropsLimit | 0) || 3;
        if (Array.isArray(all.drops) && all.drops.length > limit) {
            all.drops = { truncated: true, count: all.drops.length, sample: all.drops.slice(0, limit) };
        }
        reply({ id: f.id, ok: true, response: all });
        return;
    }
    if (type === 'get-gql') {
        const stored = await chrome.storage.local.get(['gqlTable', 'gqlDrift']);
        reply({ id: f.id, ok: true, response: { table: stored.gqlTable || null, drift: stored.gqlDrift || null } });
        return;
    }
    if (type === 'list-tabs') {
        const tabs = await chrome.tabs.query({});
        reply({ id: f.id, ok: true, response: tabs.map(t => ({ id: t.id, windowId: t.windowId, active: t.active, discarded: !!t.discarded, autoDiscardable: t.autoDiscardable, status: t.status, title: (t.title || '').slice(0, 80), url: ((t.pendingUrl || t.url) || '').slice(0, 160) })) });
        return;
    }
    if (type === 'focus-tab') {
        try {
            const tab = await chrome.tabs.get(f.tabId);
            await chrome.tabs.update(tab.id, { active: true });
            await chrome.windows.update(tab.windowId, { focused: true });
            reply({ id: f.id, ok: true, response: { focused: tab.id } });
        } catch (e) { reply({ id: f.id, ok: false, error: String((e && e.message) || e) }); }
        return;
    }
    if (type === 'reload-tab') {
        chrome.tabs.reload(f.tabId, {}, () => {
            const err = chrome.runtime.lastError;
            reply({ id: f.id, ok: !err, response: { reloaded: f.tabId }, error: err ? err.message : undefined });
        });
        return;
    }
    if (type === 'page-op') {
        reply({ id: f.id, ok: true, response: await runPageOp(f.tabId, f.op, f.args) });
        return;
    }
    if (type === 'fetch-text') {
        reply({ id: f.id, ok: true, response: await fetchBridgeText(f.url, f.name) });
        return;
    }
    if (DEV_PARITY_ACTIONS.has(type)) {
        let done = false;
        const send = (resp) => {
            if (done) return;
            done = true;
            reply({ id: f.id, ok: resp?.ok !== false, response: resp });
        };
        try { handleExtensionAction({ action: type, ...f }, { id: 'ws-bridge' }, send); } catch (e) { send({ ok: false, error: String((e && e.message) || e) }); }
        setTimeout(() => send({ ok: false, error: 'action produced no response' }), 20000);
        return;
    }
    reply({ id: f.id, ok: false, error: 'unknown command (try help)' });
}

// Page-op registry for bridge page-op. Static functions only: executeScript
// serializes them, page CSP kills eval strings. Runs in MAIN world so
// window._lolWatcher is visible.
function popState() {
    try {
        const w = window._lolWatcher || null;
        if (!w) return { ok: true, value: { present: false } };
        const s = w._rmsState || null;
        return { ok: true, value: {
            present: true,
            forceFixEnabled: w.forceFixEnabled,
            debugMode: w.debugMode,
            fakePlayerEnabled: w.fakePlayerEnabled,
            rmsTrace: (w._rmsTrace || []).slice(-80),
            rmsState: s ? {
                hasSocket: !!s.socket,
                socketState: s.socket ? s.socket.readyState : null,
                hasUrl: !!s.url,
                idleSec: s.lastActivity ? Math.round((Date.now() - s.lastActivity) / 1000) : null,
                probeDelayMs: s.probeDelay,
                intentional: !!s.intentional,
                probePending: !!s.reconnectTimer
            } : null
        } };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function popNet(a) {
    try {
        const f = String((a && a.filter) || 'rms');
        const lim = Math.min((a && a.limit | 0) || 40, 200);
        const out = [];
        for (const r of performance.getEntriesByType('resource')) {
            if (f && !(r.name || '').toLowerCase().includes(f.toLowerCase())) continue;
            out.push({ n: (r.name || '').split('?')[0].slice(0, 140), type: r.initiatorType, start: Math.round(r.startTime), dur: Math.round(r.duration), size: r.transferSize || 0 });
            if (out.length >= lim) break;
        }
        return { ok: true, value: { page: location.href.split('?')[0], count: out.length, entries: out } };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function popDom(a) {
    try {
        const els = Array.from(document.querySelectorAll(String((a && a.sel) || ''))).slice(0, (a && a.limit | 0) || 20);
        return { ok: true, value: els.map(el => ({ tag: el.tagName, id: el.id || null, cls: String(el.className || '').slice(0, 80), text: String(el.innerText || '').slice(0, 120) })) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function popAttr(a) {
    try {
        const els = Array.from(document.querySelectorAll(String((a && a.sel) || ''))).slice(0, (a && a.limit | 0) || 20);
        const attr = String((a && a.attr) || 'aria-label');
        return { ok: true, value: els.map(el => ({ text: String(el.innerText || '').slice(0, 80), attr: (el.getAttribute && el.getAttribute(attr)) || '' })) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function popScripts() {
    try {
        return { ok: true, value: Array.from(document.querySelectorAll('script[src]')).map(s => s.src.split('?')[0]).filter(s => s.includes('lolesports.com')).slice(0, 100) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function popLs(a) {
    try {
        const f = String((a && a.filter) || '');
        const store = (a && a.ses) ? sessionStorage : localStorage;
        const out = [];
        for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (f && !k.toLowerCase().includes(f.toLowerCase())) continue;
            out.push({ k, v: String(store.getItem(k) || '').slice(0, 200) });
            if (out.length >= 100) break;
        }
        return { ok: true, value: { keys: store.length, matches: out } };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function popNow() {
    try {
        return { ok: true, value: {
            href: location.href.split('?')[0],
            lang: document.documentElement.lang || null,
            hidden: document.hidden,
            visibility: document.visibilityState,
            wasDiscarded: !!document.wasDiscarded,
            perfNow: Math.round(performance.now()),
            cookies: document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(Boolean)
        } };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

const PAGE_OPS = { state: popState, net: popNet, dom: popDom, attr: popAttr, scripts: popScripts, ls: popLs, now: popNow };

async function runPageOp(tabId, op, args) {
    const fn = PAGE_OPS[op];
    if (!fn) return { ok: false, error: 'unknown op (try: state, net, dom, attr, scripts, ls, now)' };
    try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fn, args: [args || {}] });
        return res?.result || { ok: false, error: 'no result' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Bridge fetch-text: pull a lolesports.com JS/JSON files.
// The server saves the body to dumps
async function fetchBridgeText(url, name) {
    let u;
    try { u = new URL(url); } catch (e) { return { ok: false, error: 'bad url' }; }
    const h = u.hostname;
    if (u.protocol !== 'https:' || !(h === 'lolesports.com' || h.endsWith('.lolesports.com') || h === 'esports-api.lolesports.com')) {
        return { ok: false, error: 'host not allowed (lolesports.com / esports-api.lolesports.com only)' };
    }
    try {
        const r = await fetch(u.href, { credentials: 'omit' });
        const text = await r.text();
        return { ok: r.ok, status: r.status, url: u.href, name: name || (u.pathname.split('/').pop() || 'page.txt'), size: text.length, text };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.devBridgeEnabled || changes.devBridgeUrl) devBridgeReconnect();
});
devBridgeTick();
