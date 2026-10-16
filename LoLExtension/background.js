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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

    if (message.action === "log") {
        debugLog(`[Content] ${message.message}`);
    }
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
        return await new Promise((resolve, reject) => {
            chrome.windows.create({ url, state }, (window) => {
                if (chrome.runtime.lastError || !window) {
                    reject(`Failed to create window: ${chrome.runtime.lastError?.message}`);
                } else {
                    resolve(window);
                }
            });
        });
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

const streamURL = async (matchURL, leagueName) => {
    const provider = await getFromLocalStorage('provider', PROVIDER_TWITCH);

    if (provider) {
        debugLog(`streamURL(${leagueName}): using base URL, inject.js handles ${provider}`);
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

async function openWindowForLeague(matchURL, leagueName, matchID, timeNow) {
    const windowState = await getFromLocalStorage('windowState', 'normal');
    const url = await streamURL(matchURL, leagueName);
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
            resolve(tabs && tabs.length > 0 ? tabs[0] : null);
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
                chrome.tabs.update(tab.id, { url: matchURL }, resolve);
                debugLog(`Updated tab ${tab.id} from ${tab.url} to ${matchURL}`);
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
