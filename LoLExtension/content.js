const _tag = window.location.pathname.split('/')[2] || 'home';
const log = (msg) => chrome.runtime.sendMessage({ action: 'log', message: `[${_tag}] ${msg}` });
let dropsQueue = Promise.resolve();

log('Content script loaded.');

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "togglePlayerRemoval") {
        if (message.enabled) {
            log('Player Removal ENABLED.');
            chrome.storage.local.get(["forceFixEnabled", "debugMode", "provider"], (data) => {
                window.postMessage({
                    type: 'LOL_WATCHER_CONFIG',
                    config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, preferredProvider: data.provider || 'twitch', removePlayerEnabled: true }
                }, '*');
            });
            enablePlayerRemoval();
        } else {
            log('Player Removal DISABLED. (Reload the page to restore the real player.)');
            chrome.storage.local.get(["forceFixEnabled", "debugMode", "provider"], (data) => {
                window.postMessage({
                    type: 'LOL_WATCHER_CONFIG',
                    config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, preferredProvider: data.provider || 'twitch', removePlayerEnabled: false }
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
let urlCheckInterval = null;

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

// Preferred-provider lock: hides other provider radios, auto-selects once per page.
let preferredProvider = null;
let providerLockUrl = null;
let providerLockAttempted = false;
let providerStyleEl = null;
let providerHideValue = null;
// Provider fallback: preferred first, then twitch/youtube/afreecatv/trovo. No kick/soop, they never earn.
const PROVIDER_FALLBACK_ORDER = ['twitch', 'youtube', 'afreecatv', 'trovo'];

function providerChain() {
    return [preferredProvider, ...PROVIDER_FALLBACK_ORDER.filter(p => p !== preferredProvider)];
}

function availableProviders() {
    const seen = [];
    for (const b of document.querySelectorAll('div[role="radiogroup"] button[role="radio"][value]')) {
        const v = b.getAttribute('value');
        if (v && !seen.includes(v)) seen.push(v);
    }
    return seen;
}

function effectiveProvider() {
    const have = new Set(availableProviders());
    for (const p of providerChain()) {
        if (p && have.has(p)) return p;
    }
    return null;
}

function updateProviderHide() {
    const eff = (preferredProvider && isLivePage()) ? effectiveProvider() : null;
    if (eff === providerHideValue) return;
    providerHideValue = eff;
    if (providerStyleEl) { providerStyleEl.remove(); providerStyleEl = null; }
    if (!eff) return;
    providerStyleEl = document.createElement('style');
    providerStyleEl.id = 'lol-watcher-provider-lock';
    providerStyleEl.textContent =
        `div[role="radiogroup"] button[role="radio"][value]:not([value="${eff}"]){display:none !important}`;
    (document.head || document.documentElement).appendChild(providerStyleEl);
}

function selectedProviderValue() {
    const btns = document.querySelectorAll('div[role="radiogroup"] button[role="radio"][value]');
    for (const b of btns) {
        if (b.getAttribute('data-selected') === 'true' || b.getAttribute('aria-checked') === 'true') {
            return b.getAttribute('value');
        }
    }
    return null;
}

function applyProviderLock() {
    if (!preferredProvider || !isLivePage()) return;
    if (location.href !== providerLockUrl) {
        providerLockUrl = location.href;
        providerLockAttempted = false;
    }
    updateProviderHide();
    if (providerLockAttempted) return;
    const eff = effectiveProvider();
    if (!eff) return;
    const selected = selectedProviderValue();
    if (!selected || selected === eff) return;
    const target = document.querySelector(
        `div[role="radiogroup"] button[role="radio"][value="${eff}"]`);
    if (!target) return;
    providerLockAttempted = true;
    log(`Provider lock: switching ${selected} -> ${eff}` +
        (eff !== preferredProvider ? ` (fallback, ${preferredProvider} unavailable)` : ''));
    target.click();
}

let providerLockObserver = null;
function enableProviderLock() {
    updateProviderHide();
    if (!preferredProvider || !isLivePage()) return;
    applyProviderLock();
    if (providerLockObserver) return;
    const root = document.querySelector('#__next') || document.body || document.documentElement;
    providerLockObserver = new MutationObserver(() => applyProviderLock());
    providerLockObserver.observe(root, { childList: true, subtree: true });
}

function enablePlayerRemoval() {
    disconnectObserver();
    removalEnabled = true;
    fakeHeartbeatOk = false;
    if (isLivePage()) {
        watchLivePlayer();
    } else if (location.href.startsWith("https://lolesports.com")) {
        waitForElement(HOMEPAGE_PLAYER_SECTION, removeHomepagePlayer);
    }
    if (!urlCheckInterval) {
        let lastUrl = location.href;
        urlCheckInterval = setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                setTimeout(enablePlayerRemoval, 1500);
            }
        }, 2000);
    }
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
    if (urlCheckInterval) { clearInterval(urlCheckInterval); urlCheckInterval = null; }
}

function postConfig(data) {
    window.postMessage({
        type: 'LOL_WATCHER_CONFIG',
        config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, preferredProvider: data.provider || 'twitch', removePlayerEnabled: !!data.removePlayerEnabled, gqlTable: data.gqlTable || null }
    }, '*');
}

let gqlTable = null;

chrome.storage.local.get(["removePlayerEnabled", "forceFixEnabled", "debugMode", "provider", "gqlTable"], (data) => {
    preferredProvider = data.provider || 'twitch';
    gqlTable = data.gqlTable || null;
    if (data.removePlayerEnabled) enablePlayerRemoval();
    enableProviderLock();
    postConfig(data);
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.provider) {
        preferredProvider = changes.provider.newValue || 'twitch';
        providerLockAttempted = false;
        enableProviderLock();
        chrome.storage.local.get(["removePlayerEnabled", "forceFixEnabled", "debugMode", "provider", "gqlTable"], postConfig);
    }
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

    if (event.data?.type === 'LOL_WATCHER_REQUEST_CONFIG') {
        chrome.storage.local.get(["removePlayerEnabled", "forceFixEnabled", "debugMode", "provider", "gqlTable"], (data) => {
            if (!preferredProvider) preferredProvider = data.provider || 'twitch';
            if (!gqlTable) gqlTable = data.gqlTable || null;
            window.postMessage({
                type: 'LOL_WATCHER_CONFIG',
                config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, preferredProvider: data.provider || 'twitch', removePlayerEnabled: !!data.removePlayerEnabled, gqlTable: data.gqlTable || null }
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

