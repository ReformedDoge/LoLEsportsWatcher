const _tag = window.location.pathname.split('/')[2] || 'home';
const log = (msg) => chrome.runtime.sendMessage({ action: 'log', message: `[${_tag}] ${msg}` });
let dropsQueue = Promise.resolve();

log('Content script loaded.');

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "togglePlayerRemoval") {
        if (message.enabled) {
            log('Player Removal ENABLED.');
            enablePlayerRemoval();
        } else {
            log('Player Removal DISABLED.');
            removeListeners();
        }
    }
});

const HOMEPAGE_PLAYER_SECTION = 'section[data-tag="media"]';
const LIVE_PLAYER = "#video-player";
const REWARDS_BUTTON = '.status-summary[role="button"]';
const OBSERVER_TIMEOUT = 30000;

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
    const player = document.querySelector(LIVE_PLAYER);
    if (player) { player.remove(); log('Removed live video player'); }
}

function enablePlayerRemoval() {
    disconnectObserver();
    if (location.href.startsWith("https://lolesports.com/live/")) {
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
    if (document.querySelector(REWARDS_BUTTON)) {
        removeLivePlayer();
    }
    const root = document.querySelector('#__next') || document.body || document.documentElement;
    currentObserver = new MutationObserver(() => {
        if (document.querySelector(REWARDS_BUTTON)) {
            removeLivePlayer();
        }
    });
    currentObserver.observe(root, { childList: true, subtree: true });
}

function removeListeners() {
    disconnectObserver();
    if (urlCheckInterval) { clearInterval(urlCheckInterval); urlCheckInterval = null; }
}

chrome.storage.local.get(["removePlayerEnabled", "forceFixEnabled", "debugMode", "provider"], (data) => {
    if (data.removePlayerEnabled) enablePlayerRemoval();
    window.postMessage({
        type: 'LOL_WATCHER_CONFIG',
        config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, preferredProvider: data.provider }
    }, '*');
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
        chrome.storage.local.get(["forceFixEnabled", "debugMode", "provider"], (data) => {
            window.postMessage({
                type: 'LOL_WATCHER_CONFIG',
                config: { forceFixEnabled: data.forceFixEnabled ?? true, debugMode: !!data.debugMode, preferredProvider: data.provider }
            }, '*');
        });
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

