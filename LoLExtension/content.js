const _tag = window.location.pathname.split('/')[2] || 'home';
const log = (msg) => chrome.runtime.sendMessage({ action: 'log', message: `[${_tag}] ${msg}` });
let dropsQueue = Promise.resolve();

log('Content script loaded.');
try {
    if (document.wasDiscarded) log('Tab was discarded by the browser, fresh boot after discard');
    if (document.hidden) log('Tab hidden at boot (background tab, throttling likely)');
} catch (e) {}

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "togglePlayerRemoval") {
        if (message.enabled) {
            log('Player Removal ENABLED.');
            chrome.storage.local.get(["forceFixEnabled", "debugMode", "provider"], (data) => {
                window.postMessage({
                    type: 'LOL_WATCHER_CONFIG',
                    config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, removePlayerEnabled: true }
                }, '*');
            });
            enablePlayerRemoval();
        } else {
            log('Player Removal DISABLED. (Reload the page to restore the real player.)');
            chrome.storage.local.get(["forceFixEnabled", "debugMode", "provider"], (data) => {
                window.postMessage({
                    type: 'LOL_WATCHER_CONFIG',
                    config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, removePlayerEnabled: false }
                }, '*');
            });
            removeListeners();
        }
    }
});

const HOMEPAGE_PLAYER_SECTION = 'section[data-tag="media"]';
// Removes #video-player-placeholder (or legacy #video-player). Layout box stays intact.
const LIVE_PLAYER_SELECTORS = ['#video-player-placeholder', '#video-player'];
const OBSERVER_TIMEOUT = 30000;
// Grace period for the heartbeat-or-button fallback.
const WATCH_OK_TIMEOUT = 90000;

let fakeHeartbeatOk = false;
// Master switch for all player removal paths.
let removalEnabled = false;

let currentObserver = null;
let currentObserverTimeout = null;

function disconnectObserver() {
    if (currentObserverTimeout) {
        clearTimeout(currentObserverTimeout);
        currentObserverTimeout = null;
    }
    if (currentObserver) {
        currentObserver.disconnect();
        currentObserver = null;
    }
}

function waitForElement(selector, callback) {
    if (document.querySelector(selector)) { callback(); return; }
    disconnectObserver();
    const root = document.querySelector('#__next') || document.body || document.documentElement;
    currentObserver = new MutationObserver((mutations, obs) => {
        if (document.querySelector(selector)) {
            callback();
            disconnectObserver();
        }
    });
    currentObserver.observe(root, { childList: true, subtree: true });
    currentObserverTimeout = setTimeout(disconnectObserver, OBSERVER_TIMEOUT);
}

function removeHomepagePlayer() {
    const section = document.querySelector(HOMEPAGE_PLAYER_SECTION);
    if (section) { section.remove(); log('Removed homepage player section'); }
}

function removeLivePlayer() {
    for (const sel of LIVE_PLAYER_SELECTORS) {
        const player = document.querySelector(sel);
        if (player) {
            // The heartbeat holds the player object, not the DOM node.
            player.remove();
            log(`Removed live video player (${sel})`);
            return true;
        }
    }
    return false;
}

// Rewards button: button[aria-expanded][aria-controls] with a [data-type] icon.
function findRewardsButton() {
    const btns = document.querySelectorAll('button[aria-expanded][aria-controls]');
    for (const b of btns) {
        if (b.getAttribute('aria-label')) continue;
        if (b.querySelector('[data-type]')) return b;
    }
    return null;
}

function isLivePage() {
    return location.href.includes('/live/');
}

// Stream URLs resolve provider-side, the page always boots on the right one.
let lastNavUrl = location.href;

function enablePlayerRemoval() {
    disconnectObserver();
    removalEnabled = true;
    fakeHeartbeatOk = false;
    lastNavUrl = location.href;
    if (isLivePage()) {
        watchLivePlayer();
    } else if (location.href.startsWith("https://lolesports.com")) {
        waitForElement(HOMEPAGE_PLAYER_SECTION, removeHomepagePlayer);
    }
    ensurePageObserver();
}

function watchLivePlayer() {
    // Remove after heartbeat confirmation, or when the rewards button renders.
    if (fakeHeartbeatOk || findRewardsButton()) {
        if (removeLivePlayer()) disconnectObserver();
    }
    const root = document.querySelector('#__next') || document.body || document.documentElement;
    disconnectObserver();
    currentObserver = new MutationObserver(() => {
        if (!removalEnabled) return;
        if (fakeHeartbeatOk || findRewardsButton()) {
            if (removeLivePlayer()) disconnectObserver();
        }
    });
    currentObserver.observe(root, { childList: true, subtree: true });
    currentObserverTimeout = setTimeout(() => {
        disconnectObserver();
        if (!removalEnabled) return;
        if (!fakeHeartbeatOk) {
            // Final fallback attempt.
            if (removeLivePlayer()) log('Removed live video player (late fallback)');
            else log('Player removal timed out: no heartbeat and no rewards button seen');
        }
    }, Math.max(OBSERVER_TIMEOUT, WATCH_OK_TIMEOUT));
}

function removeListeners() {
    removalEnabled = false;
    disconnectObserver();
    if (grayClock) { clearInterval(grayClock); grayClock = null; }
}

// Rewards state from the indicator icon, panel links split the gray cases.
function rewardsState() {
    const btn = findRewardsButton();
    if (!btn) return 'hidden';
    const t = btn.querySelector('[data-type]')?.getAttribute('data-type');
    if (t === 'ok') return 'green';
    if (t === 'error') return 'red';
    if (t !== 'info') return 'hidden';
    const root = btn.closest('div[data-open]');
    if (root?.querySelector('a[href="/rewards"]')) return 'optedout';
    return 'loggedout';
}

// Reload on logged-out only, capped per tab. Opted-out is server-side.
let graySince = 0;
let grayOptedOutLogged = false;
let grayClock = null;
let lastRewardState = null;

function evaluateGray(st) {
    const s = st ?? (() => { try { return rewardsState(); } catch (e) { return null; } })();
    if (s === 'optedout') {
        if (!grayOptedOutLogged) {
            grayOptedOutLogged = true;
            log('Rewards opted out (see /rewards), reload cannot fix this');
        }
        graySince = 0;
        return;
    }
    if (s !== 'loggedout' || !removalEnabled) { graySince = 0; return; }
    if (!graySince) { graySince = Date.now(); return; }
    if (Date.now() - graySince < 120000) return;
    let n = 0;
    try { n = parseInt(sessionStorage.getItem('lolGrayReloads') || '0', 10) || 0; } catch (e) {}
    if (n < 2) {
        try { sessionStorage.setItem('lolGrayReloads', String(n + 1)); } catch (e) {}
        log(`Rewards logged out for 120s, reloading (attempt ${n + 1}/2)`);
        location.reload();
    } else {
        log('Rewards logged out after reloads, giving up for this tab');
        if (grayClock) { clearInterval(grayClock); grayClock = null; }
    }
}

// One persistent observer drives removal and gray/refire evaluation.
// The 30s clock below only enforces the 120s gray deadline.
let pageObserver = null;

function ensurePageObserver() {
    if (pageObserver || !isLivePage()) return;
    const root = document.querySelector('#__next') || document.body || document.documentElement;
    pageObserver = new MutationObserver(() => {
        if (removalEnabled && !fakeHeartbeatOk && findRewardsButton()) {
            if (removeLivePlayer()) disconnectObserver();
        }
        let st = null;
        try { st = rewardsState(); } catch (e) {}
        if (st && st !== 'hidden' && st !== lastRewardState && (st === 'loggedout' || st === 'red')) {
            window.postMessage({ type: 'LOL_WATCHER_REFIRE_REQUEST' }, '*');
        }
        if (st !== lastRewardState) lastRewardState = st;
        evaluateGray(st);
    });
    pageObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-type'] });
    grayClock = setInterval(() => { if (removalEnabled) evaluateGray(); }, 30000);
}

function handleUrlChange(url) {
    if (url === lastNavUrl) return;
    lastNavUrl = url;
    disconnectObserver();
    fakeHeartbeatOk = false;
    graySince = 0;
    lastRewardState = null;
    if (removalEnabled && isLivePage()) watchLivePlayer();
}

window.addEventListener('popstate', () => handleUrlChange(location.href));
window.addEventListener('hashchange', () => handleUrlChange(location.href));

function postConfig(data) {
    window.postMessage({
        type: 'LOL_WATCHER_CONFIG',
        config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, removePlayerEnabled: !!data.removePlayerEnabled, gqlTable: data.gqlTable || null }
    }, '*');
}

let gqlTable = null;

chrome.storage.local.get(["removePlayerEnabled", "forceFixEnabled", "debugMode", "provider", "gqlTable"], (data) => {
    gqlTable = data.gqlTable || null;
    if (data.removePlayerEnabled) enablePlayerRemoval();
    ensurePageObserver();
    postConfig(data);
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.gqlTable) {
        const prev = gqlTable ? Object.keys(gqlTable.ops || {}).sort().join(',') : '';
        gqlTable = changes.gqlTable.newValue || null;
        const next = gqlTable ? Object.keys(gqlTable.ops || {}).sort().join(',') : '';
        if (next !== prev) {
            chrome.storage.local.get(["removePlayerEnabled", "forceFixEnabled", "debugMode", "provider", "gqlTable"], postConfig);
        }
    }
});

// Drop Tracking & Webpack/Fetch Interceptors
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
document.documentElement.appendChild(script);
script.remove();

async function resolveDropLeagueName(details) {
    let leagueName = null;
    if (details?.leagueID) {
        leagueName = await new Promise(r => chrome.runtime.sendMessage({ action: 'resolveLeagueName', leagueID: details.leagueID }, resp => r(resp?.leagueName || null)));
    }
    if (!leagueName && details?.inventory?.[0]?.localizedInventory?.inventory?.internalTitle) {
        const word = details.inventory[0].localizedInventory.inventory.internalTitle.split(/[\s-]+/)[0];
        if (word && /^[A-Z0-9]{2,8}$/i.test(word) && word.toLowerCase() !== word) {
            leagueName = word.toUpperCase();
            log(`Fallback: extracted league "${leagueName}" from internalTitle`);
        }
    }
    return leagueName;
}

async function reconcileDropLeagues() {
    const res = await chrome.storage.local.get({ drops: [] });
    const drops = res.drops || [];
    let changed = 0;
    let needsWrite = false;
    const updated = [];
    for (const d of drops) {
        if (d.leagueResolved || !d.details?.leagueID) { updated.push(d); continue; }
        const leagueName = await resolveDropLeagueName(d.details);
        if (leagueName) {
            updated.push({ ...d, league: leagueName, leagueResolved: true });
            needsWrite = true;
            if (d.league !== leagueName) {
                log(`Reconciled league for drop from "${d.league}" to "${leagueName}" via leagueID`);
                changed++;
            }
        } else {
            updated.push(d);
        }
    }
    if (needsWrite) {
        await chrome.storage.local.set({ drops: updated });
        if (changed > 0) log(`Reconciled league names for ${changed} drops via leagueID.`);
    }
}

// Retroactively enrich drops missing details (triggered via message from popup)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'enrich-drops') {
        chrome.storage.local.get({ drops: [] }, async (res) => {
            const drops = res.drops || [];
            let count = 0;
            for (let i = 0; i < drops.length; i++) {
                if (drops[i].details) continue;
                try {
                    const inner = JSON.parse(drops[i].payload.payload);
                    const dropId = inner.message?.i;
                    if (!dropId) continue;
                    window.postMessage({ type: 'LOL_WATCHER_FETCH_DETAILS', dropId }, '*');
                    count++;
                } catch (e) {}
            }
            if (count > 0) log(`Requested enrichment for ${count} drops.`);
            sendResponse({ requested: count });
        });
        dropsQueue = dropsQueue.then(() => reconcileDropLeagues());
        return true;
    }
});

window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'LOL_WATCHER_STATUS') {
        chrome.storage.local.set({ injectStatus: event.data.status });
        log(`Inject status: ${JSON.stringify(event.data.status)}`);
        chrome.storage.local.get({ drops: [] }, (res) => {
            const drops = res.drops || [];
            let count = 0;
            for (const drop of drops) {
                if (drop.details) continue;
                try {
                    const inner = JSON.parse(drop.payload.payload);
                    const dropId = inner.message?.i;
                    if (!dropId) continue;
                    window.postMessage({ type: 'LOL_WATCHER_FETCH_DETAILS', dropId }, '*');
                    count++;
                } catch (e) {}
            }
            if (count > 0) log(`Auto-enriched ${count} drops on page load.`);
        });
        dropsQueue = dropsQueue.then(() => reconcileDropLeagues());
        return;
    }

    if (event.data?.type === 'LOL_WATCHER_PAGE_LOG') {
        log(`[Inject] ${event.data.message}`);
        return;
    }

    if (event.data?.type === 'LOL_WATCHER_URL_CHANGED') {
        handleUrlChange(event.data.url || location.href);
        return;
    }

    if (event.data?.type === 'LOL_WATCHER_REQUEST_CONFIG') {
        chrome.storage.local.get(["removePlayerEnabled", "forceFixEnabled", "debugMode", "provider", "gqlTable"], (data) => {
            if (!gqlTable) gqlTable = data.gqlTable || null;
            window.postMessage({
                type: 'LOL_WATCHER_CONFIG',
                config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, removePlayerEnabled: !!data.removePlayerEnabled, gqlTable: data.gqlTable || null }
            }, '*');
        });
        return;
    }

    if (event.data?.type === 'LOL_WATCHER_GQL_SEEN' || event.data?.type === 'LOL_WATCHER_GQL_CHUNKS' || event.data?.type === 'LOL_WATCHER_GQL_ERROR') {
        chrome.runtime.sendMessage({ action: 'gqlSeen', kind: event.data.type, payload: event.data.pairs || event.data.chunks || { op: event.data.op, status: event.data.status } });
        return;
    }

    if (event.data?.type === 'LOL_WATCHER_FAKE_HEARTBEAT') {
        if (!removalEnabled) return;
        if (event.data.state === 'watch-ok') {
            if (!fakeHeartbeatOk) {
                fakeHeartbeatOk = true;
                log('Heartbeat confirmed (rex events/watch OK) — removing player');
                if (removeLivePlayer()) disconnectObserver();
            }
        } else if (event.data.state === 'fake-init') {
            log(`Fake ${event.data.provider || ''} player attached (no video bandwidth)`);
        }
        return;
    }

    if (event.data?.type === 'LOL_DROP_DETAILS') {
        const details = event.data.details;
        const dropId = event.data.dropId;
        dropsQueue = dropsQueue.then(() => new Promise(outerResolve => {
            chrome.storage.local.get({ drops: [] }, (res) => {
                const existing = (res.drops || []).find(d => {
                    try {
                        const inner = JSON.parse(d.payload.payload);
                        return inner.message?.i === dropId;
                    } catch (e) { return false; }
                });
                if (existing?.details) {
                    if (!existing.leagueResolved && existing.details?.leagueID) {
                        dropsQueue = dropsQueue.then(() => reconcileDropLeagues());
                    }
                    outerResolve();
                    return;
                }
                resolveDropLeagueName(details).then(leagueName => {
                    chrome.storage.local.get({ drops: [] }, (res) => {
                        const updated = (res.drops || []).map(d => {
                            try {
                                const inner = JSON.parse(d.payload.payload);
                                if (inner.message?.i === dropId) {
                                    const update = { ...d, details };
                                    if (leagueName) {
                                        update.league = leagueName;
                                        update.leagueResolved = true;
                                        if (d.league !== leagueName) {
                                            log(`Fixed league for drop from "${d.league}" to "${leagueName}" via enrichment`);
                                        }
                                    }
                                    return update;
                                }
                            } catch (e) {}
                            return d;
                        });
                        chrome.storage.local.set({ drops: updated }, outerResolve);
                        log('Drop enriched with details via page fetch.');
                    });
                });
            });
        }));
        return;
    }

    if (event.data?.type === 'NEW_LOL_DROP') {
        dropsQueue = dropsQueue.then(() => new Promise(outerResolve => {
            chrome.storage.local.get({ drops: [] }, (res) => {
                const drops = res.drops || [];
                try {
                    const innerPayload = JSON.parse(event.data.drop.payload.payload);
                    const isDuplicate = drops.some(d => {
                        try {
                            const existingInner = JSON.parse(d.payload.payload);
                            return existingInner.id === innerPayload.id;
                        } catch (e) { return false; }
                    });
                    
                    if (!isDuplicate) {
                        drops.unshift({ ...event.data.drop, seen: false });
                        chrome.storage.local.set({ drops });
                        log('Saved new unique drop to storage.');
                    }
                } catch (e) {
                    log(`Failed to parse drop for deduplication: ${e.message}`);
                }
                outerResolve();
            });
        }));
        return;
    }
});

