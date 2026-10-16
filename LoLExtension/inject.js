(function() {
    window._lolWatcher = { forceFixEnabled: true, debugMode: false, fakePlayerEnabled: false };
    const pageLog = (msg) => window.postMessage({ type: 'LOL_WATCHER_PAGE_LOG', message: msg }, '*');
    const debug = (...args) => window._lolWatcher.debugMode && pageLog(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    const notifyFake = (state, extra) => window.postMessage({ type: 'LOL_WATCHER_FAKE_HEARTBEAT', state, ...(extra || {}) }, '*');

    // GQL observer: harvest op/hash pairs, flag bad statuses. No body reads.
    const _gqlSeenHashes = {};
    try {
        const _chunksSeen = {};
        const reportChunk = (u) => {
            if (!u || _chunksSeen[u]) return;
            _chunksSeen[u] = true;
            window.postMessage({ type: 'LOL_WATCHER_GQL_CHUNKS', chunks: [u] }, '*');
        };
        const isChunk = (u) => typeof u === 'string' && u.includes('/_next/static/chunks/') && u.endsWith('.js');
        try {
            for (const e of performance.getEntriesByType('resource')) {
                if (isChunk(e.name)) reportChunk(e.name);
            }
        } catch (e) {}
        if (typeof PerformanceObserver !== 'undefined') {
            new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    if (isChunk(e.name)) reportChunk(e.name);
                }
            }).observe({ entryTypes: ['resource'] });
        }
    } catch (e) {}

    function gqlRequestInfo(url, options) {
        try {
            let op = null, hash = null;
            const urlStr = typeof url === 'string' ? url : (url && typeof url.url === 'string' ? url.url : null);
            if (urlStr) {
                const q = urlStr.indexOf('?');
                if (q !== -1) {
                    const qs = urlStr.slice(q + 1);
                    const mOp = /(?:^|&)operationName=([^&]+)/.exec(qs);
                    if (mOp) op = decodeURIComponent(mOp[1]);
                    const mExt = /(?:^|&)extensions=([^&]+)/.exec(qs);
                    if (mExt) {
                        const mH = /"sha256Hash"\s*:\s*"([a-f0-9]{64})"/.exec(decodeURIComponent(mExt[1]));
                        if (mH) hash = mH[1];
                    }
                }
            }
            const body = options && typeof options.body === 'string' && options.body.length < 60000 ? options.body : null;
            if (body) {
                if (!op) {
                    const m = /"operationName"\s*:\s*"([^"]+)"/.exec(body);
                    if (m) op = m[1];
                }
                if (!hash) {
                    const m = /"sha256Hash"\s*:\s*"([a-f0-9]{64})"/.exec(body);
                    if (m) hash = m[1];
                }
            }
            if (op || hash) return { op, hash };
        } catch (e) {}
        return null;
    }

    function reportGqlPair(op, hash) {
        if (!op || !hash || _gqlSeenHashes[op] === hash) return;
        _gqlSeenHashes[op] = hash;
        window.postMessage({ type: 'LOL_WATCHER_GQL_SEEN', pairs: { [op]: hash } }, '*');
    }

    // Fake Twitch/YouTube players: no iframe, no video bandwidth. Gated by removePlayerEnabled.
    const TWITCH_STATIC_DEFAULTS = { READY: 'ready', PLAYING: 'playing', PAUSE: 'pause', ENDED: 'ended', PLAY: 'play', PLAYBACK_BLOCKED: 'playback_blocked', OFFLINE: 'offline', ONLINE: 'online' };

    // Stored PLAYING refires, fired on demand by state transitions and tab return.
    window._lolWatcher._authRefire = window._lolWatcher._authRefire || [];

    // Re-fire stored PLAYING listeners on demand. Repeat onPlay is a no-op
    // while beating, and a no-op when disabled, so triggers stay cheap.
    function fireAllPlaying() {
        if (!window._lolWatcher.fakePlayerEnabled) return;
        for (const fn of (window._lolWatcher._authRefire || [])) {
            try { fn(); } catch (e) {}
        }
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) fireAllPlaying(); });
    document.addEventListener('freeze', () => pageLog('[LoL Watcher] Document FROZEN, JS suspended.'), true);
    document.addEventListener('resume', () => { pageLog('[LoL Watcher] Document RESUMED.'); fireAllPlaying(); }, true);
    window.addEventListener('focus', () => fireAllPlaying());
    window.addEventListener('online', () => fireAllPlaying());
    window.addEventListener('pageshow', () => fireAllPlaying());

    function makeFakeTwitchPlayer(Statics, elementId, options) {
        const listeners = new Map();
        const fireLater = (cb, ms) => setTimeout(() => { try { cb(); } catch (e) {} }, ms);
        const firePlaying = () => {
            const s = listeners.get(Statics.PLAYING);
            if (s) for (const cb of [...s]) {
                try { cb(); } catch (e) {}
            }
        };
        window._lolWatcher._authRefire.push(firePlaying);
        const fake = {
            __lolWatcherFake: true,
            _elementId: elementId,
            _options: options,
            addEventListener(evt, cb) {
                if (typeof cb !== 'function') return;
                if (!listeners.has(evt)) listeners.set(evt, new Set());
                listeners.get(evt).add(cb);
                debug('[LoL Watcher] fake twitch listener:', String(evt));
                // Event order: READY at 30ms, PLAY at 60ms, PLAYING at 150ms. Never PAUSE/ENDED/OFFLINE/PLAYBACK_BLOCKED.
                if (evt === Statics.READY) fireLater(cb, 30);
                else if (evt === Statics.PLAY) fireLater(cb, 60);
                else if (evt === Statics.PLAYING) fireLater(cb, 150);
            },
            removeEventListener(evt, cb) {
                const s = listeners.get(evt);
                if (s) { if (cb) s.delete(cb); else s.clear(); }
            },
            isPaused() { return true; },
            getCurrentTime() { return 0; },
            getDuration() { return 0; },
            play() {}, pause() {}, seek() {}, setMuted() {}, setVolume() {},
            destroy() {}
        };
        return fake;
    }

    function wrapTwitchPlayer() {
        try {
            if (!window._lolWatcher.fakePlayerEnabled) return false;
            const cur = window.Twitch && window.Twitch.Player;
            if (!cur || cur.__lolWatcherFakeWrapped) return false;
            const Statics = {};
            for (const k of Object.keys(TWITCH_STATIC_DEFAULTS)) {
                Statics[k] = (cur[k] !== undefined) ? cur[k] : TWITCH_STATIC_DEFAULTS[k];
            }
            function WrappedTwitchPlayer(elementId, options) {
                pageLog('[LoL Watcher] Fake Twitch player used (no iframe, no bandwidth).');
                notifyFake('fake-init', { provider: 'twitch' });
                return makeFakeTwitchPlayer(Statics, elementId, options);
            }
            Object.assign(WrappedTwitchPlayer, Statics);
            WrappedTwitchPlayer.__lolWatcherFakeWrapped = true;
            window.Twitch.Player = WrappedTwitchPlayer;
            debug('[LoL Watcher] Wrapped Twitch.Player with fake.');
            return true;
        } catch (e) { return false; }
    }

    function makeFakeYTPlayer(elementId, opts) {
        const listeners = new Map();
        window._lolWatcher._authRefire.push(() => {
            const s = listeners.get('onStateChange');
            if (s) for (const cb of [...s]) {
                try { cb({ data: 1 }); } catch (e) {}
            }
        });
        const fake = {
            __lolWatcherFake: true,
            _elementId: elementId,
            _options: opts,
            addEventListener(evt, cb) {
                if (typeof cb !== 'function') return;
                if (!listeners.has(evt)) listeners.set(evt, new Set());
                listeners.get(evt).add(cb);
                debug('[LoL Watcher] fake youtube listener:', String(evt));
                if (evt === 'onStateChange') setTimeout(() => { try { cb({ data: 1 }); } catch (e) {} }, 60);
                else if (evt === 'onReady') setTimeout(() => { try { cb(); } catch (e) {} }, 40);
            },
            removeEventListener() {},
            getPlayerState() { return 1; },
            getMediaReferenceTime() { return Date.now() / 1000; },
            getCurrentTime() { return 0; },
            getDuration() { return 0; },
            playVideo() {}, pauseVideo() {}, mute() {}, setVolume() {}, seekTo() {},
            destroy() {}
        };
        setTimeout(() => {
            try { if (opts && opts.events && typeof opts.events.onReady === 'function') opts.events.onReady(); } catch (e) {}
            try { if (opts && opts.events && typeof opts.events.onStateChange === 'function') opts.events.onStateChange({ data: 1 }); } catch (e) {}
        }, 50);
        return fake;
    }

    function wrapYTPlayer() {
        try {
            if (!window._lolWatcher.fakePlayerEnabled) return false;
            if (!window.YT) return false;
            window.YT.PlayerState = window.YT.PlayerState || { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
            const cur = window.YT.Player;
            if (!cur || cur.__lolWatcherFakeWrapped) return false;
            function WrappedYTPlayer(elementId, opts) {
                pageLog('[LoL Watcher] Fake YouTube player used (no iframe, no bandwidth).');
                notifyFake('fake-init', { provider: 'youtube' });
                return makeFakeYTPlayer(elementId, opts);
            }
            WrappedYTPlayer.__lolWatcherFakeWrapped = true;
            window.YT.Player = WrappedYTPlayer;
            debug('[LoL Watcher] Wrapped YT.Player with fake.');
            return true;
        } catch (e) { return false; }
    }

    function setupFakePlayers() {
        if (!window._lolWatcher.fakePlayerEnabled) return;
        // Pre-seed YT namespace before the site reads it.
        try {
            if (!window.YT) window.YT = {};
            window.YT.PlayerState = window.YT.PlayerState || { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
            if (!window.YT.Player) {
                window.YT.Player = function (elementId, opts) { return makeFakeYTPlayer(elementId, opts); };
            } else {
                wrapYTPlayer();
            }
        } catch (e) {}
        wrapTwitchPlayer();
        wrapYTPlayer();
    }

    // Re-wrap on embed script load. Document capture fires before the
    // element handlers the site uses to init its player.
    const PLAYER_SCRIPT_RES = [/player\.twitch\.tv\/js\/embed/, /youtube\.com\/iframe_api/];
    const wrapPlayers = () => { wrapTwitchPlayer(); wrapYTPlayer(); };
    document.addEventListener('load', (e) => {
        const src = (e.target && e.target.src) || '';
        if (PLAYER_SCRIPT_RES.some((r) => r.test(src))) wrapPlayers();
    }, true);
    try {
        for (const s of document.scripts) {
            if (PLAYER_SCRIPT_RES.some((r) => r.test(s.src || ''))) { wrapPlayers(); break; }
        }
    } catch (e) {}

    // SPA navigation hooks, content.js re-arms on these.
    const _pushState = history.pushState, _replaceState = history.replaceState;
    const notifyUrl = () => window.postMessage({ type: 'LOL_WATCHER_URL_CHANGED', url: location.href }, '*');
    history.pushState = function() { const r = _pushState.apply(this, arguments); notifyUrl(); return r; };
    history.replaceState = function() { const r = _replaceState.apply(this, arguments); notifyUrl(); return r; };
    window.addEventListener('popstate', notifyUrl);
    window.addEventListener('hashchange', notifyUrl);

    window.addEventListener('message', (e) => {
        if (e.data?.type === 'LOL_WATCHER_REFIRE_REQUEST') { fireAllPlaying(); return; }
        if (e.data?.type === 'LOL_WATCHER_CONFIG') {
            window._lolWatcher.forceFixEnabled = e.data.config.forceFixEnabled;
            window._lolWatcher.debugMode = !!e.data.config.debugMode;
            window._lolWatcher.fakePlayerEnabled = !!e.data.config.removePlayerEnabled;
            if (e.data.config.gqlTable) window._lolWatcher.gqlTable = e.data.config.gqlTable;
            debug('[LoL Watcher] Config updated via message:', e.data.config);
            setupFakePlayers();
        }
        if (e.data?.type === 'LOL_WATCHER_FETCH_DETAILS' && e.data.dropId) {
            fetch("https://account.service.lolesports.com/fandom-account/v1/earnedDrops/" + e.data.dropId + "?locale=en_GB", {
                credentials: 'include',
                headers: { 'Authorization': 'Cookie __Secure-access_token', 'Content-Type': 'application/json' }
            }).then(function(r) { return r.ok ? r.json() : null; }).then(function(details) {
                if (details) window.postMessage({ type: 'LOL_DROP_DETAILS', dropId: e.data.dropId, details }, '*');
            }).catch(function(){});
        }
    });

    window.__LOL_WATCHER_EXTENSION_ACTIVE__ = true;
    if (typeof window.__disableUserscriptMaster === 'function') {
        window.__disableUserscriptMaster();
        pageLog("Forced previously running userscript to yield master duties.");
    } else {
        pageLog("Claimed master priority for RMS Fixes.");
    }

    const originalWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        const ws = protocols ? new originalWebSocket(url, protocols) : new originalWebSocket(url);
        if (url.includes("rms.si.lolesports.com/rms/v1/session")) {
            debug("[LoL Watcher] Intercepted RMS WebSocket creation.");
            ws.addEventListener("message", async (event) => {
                try {
                    let dataText = event.data;
                    if (event.data instanceof Blob) {
                        dataText = await event.data.text();
                    }
                    const msg = JSON.parse(dataText);
                    if (msg.subject === "rms:message" && msg.payload?.resource === "esports/v1/drop_fulfilled") {
                        debug("[LoL Watcher] Drop fulfilled message intercepted:", msg);
                        const dropData = {
                            league: window.location.pathname.split('/')[2] || 'Unknown',
                            timestamp: Date.now(),
                            ...msg
                        };
                        window.postMessage({ type: 'NEW_LOL_DROP', drop: dropData }, '*');
                        try {
                            const inner = JSON.parse(msg.payload.payload);
                            const dropId = inner.message?.i;
                            if (dropId) {
                                (function(id) {
                                    fetch("https://account.service.lolesports.com/fandom-account/v1/earnedDrops/" + id + "?locale=en_GB", {
                                        credentials: 'include',
                                        headers: { 'Authorization': 'Cookie __Secure-access_token', 'Content-Type': 'application/json' }
                                    }).then(r => r.ok ? r.json() : null).then(details => {
                                        if (details) window.postMessage({ type: 'LOL_DROP_DETAILS', dropId: id, details }, '*');
                                    }).catch(function(){});
                                })(dropId);
                            }
                        } catch (e) {}
                    }
                } catch (e) {}
            });
            ws.addEventListener("close", (event) => {
                if (window._lolWatcher.forceFixEnabled && !event.wasClean) {
                    debug("[LoL Watcher] RMS WebSocket unclean close detected. Delaying managed reconnect...");
                    setTimeout(() => {
                        const rmsManager = window._lolWatcher.rmsSocketManager;
                        if (rmsManager?.connect && rmsManager.rmsClientConfig) {
                            debug("[LoL Watcher] Forcing reconnect via captured RMS manager.");
                            rmsManager.connect(rmsManager.rmsClientConfig);
                        } else {
                            console.error("[LoL Watcher] No RMS manager captured to force reconnect.");
                        }
                    }, 5000);
                }
            });
        }
        return ws;
    };
    window.WebSocket.prototype = originalWebSocket.prototype;
    Object.assign(window.WebSocket, originalWebSocket);

    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        if (window._lolWatcher.forceFixEnabled && typeof url === 'string' && url.includes('/v1/session/clientconfig/rms')) {
            return originalFetch.apply(this, arguments).then(response => {
                if (!response.ok) throw new Error("RMS Config failed with status: " + response.status);
                return response;
            }).catch(error => {
                debug("[LoL Watcher] Original RMS config fetch failed! Injecting fallback config.", error.message);
                const fallbackConfig = {
                    "client_config_value": {
                        "rms.allow_bad_cert.enabled": false,
                        "rms.handshake_timeout_ms": 5000,
                        "rms.heartbeat_interval_seconds": 55,
                        "rms.host": "wss://eu.edge.rms.si.lolesports.com",
                        "rms.max_reconnect_delay_ms": 300000,
                        "rms.min_reconnect_delay_ms": 100,
                        "rms.port": 443,
                        "rms.protocol_preference": "ipv4",
                        "rms.socket_timeout_ms": 30000,
                        "rms.use_direct_connection": true
                    }
                };
                return new Response(JSON.stringify(fallbackConfig), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            });
        }
        return originalFetch.apply(this, arguments);
    };

    const patchedFetch = window.fetch;
    window.fetch = function(url, options) {
        // GQL observer: harvest op/hash pairs, flag bad statuses. No body reads.
        if (typeof url === 'string' || (url && typeof url.url === 'string')) {
            const urlStr = typeof url === 'string' ? url : url.url;
            if (urlStr.includes('/api/gql')) {
                const gqlInfo = gqlRequestInfo(url, options);
                if (gqlInfo && gqlInfo.hash) reportGqlPair(gqlInfo.op, gqlInfo.hash);
                else if (gqlInfo && gqlInfo.op) debug(`[LoL Watcher] gql op without hash: ${gqlInfo.op}`);
                if (gqlInfo) {
                    return patchedFetch.apply(this, arguments).then(response => {
                        if (!response.ok && (response.status === 400 || response.status === 404)) {
                            window.postMessage({ type: 'LOL_WATCHER_GQL_ERROR', op: gqlInfo.op || null, status: response.status }, '*');
                        }
                        return response;
                    });
                }
            }
        }
        if (typeof url === 'string' && url.includes('rex.rewards.lolesports.com/v1/events/watch')) {
            return patchedFetch.apply(this, arguments).then(response => {
                if (response.ok) {
                    notifyFake('watch-ok');
                    debug('[LoL Watcher] rex events/watch OK (heartbeat flowing).');
                    if (window._lolWatcher.debugMode) {
                        response.clone().json().then(d => {
                            debug(`[LoL Watcher] heartbeat flags: heartbeatability=${d.heartbeatability} droppability=${d.droppability} rewardability=${d.rewardability}`);
                        }).catch(() => {});
                    }
                } else {
                    debug(`[LoL Watcher] rex events/watch HTTP ${response.status}.`);
                }
                return response;
            }).catch((err) => {
                debug(`[LoL Watcher] rex events/watch failed: ${(err && err.message) || err}.`);
                throw err;
            });
        }
        if (typeof url === 'string' && url.includes('rex.rewards.lolesports.com/v1/streams/startInfo')) {
            return patchedFetch.apply(this, arguments).then(response => {
                if (response.ok) debug('[LoL Watcher] rex streams/startInfo OK.');
                else debug(`[LoL Watcher] rex streams/startInfo HTTP ${response.status}.`);
                if (response.ok && window._lolWatcher.debugMode) {
                    response.clone().json().then(d => {
                        debug(`[LoL Watcher] startInfo flags: heartbeatability=${d.heartbeatability} droppability=${d.droppability} rewardability=${d.rewardability}`);
                    }).catch(() => {});
                }
                return response;
            }).catch((err) => {
                debug(`[LoL Watcher] rex streams/startInfo failed: ${(err && err.message) || err}.`);
                throw err;
            });
        }
        if (window._lolWatcher.forceFixEnabled && typeof url === 'string' && url.includes('/v1/session/clientconfig/rms')) {
            return patchedFetch.apply(this, arguments).then(response => {
                if (!response.ok) throw new Error("RMS Config failed with status: " + response.status);
                return response;
            }).catch(error => {
                debug("[LoL Watcher] Original RMS config fetch failed! Injecting fallback config.", error.message);
                const fallbackConfig = {
                    "client_config_value": {
                        "rms.allow_bad_cert.enabled": false,
                        "rms.handshake_timeout_ms": 5000,
                        "rms.heartbeat_interval_seconds": 55,
                        "rms.host": "wss://eu.edge.rms.si.lolesports.com",
                        "rms.max_reconnect_delay_ms": 300000,
                        "rms.min_reconnect_delay_ms": 100,
                        "rms.port": 443,
                        "rms.protocol_preference": "ipv4",
                        "rms.socket_timeout_ms": 30000,
                        "rms.use_direct_connection": true
                    }
                };
                return new Response(JSON.stringify(fallbackConfig), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            });
        }
        return patchedFetch.apply(this, arguments);
    };

    const patchAllModules = (modules) => {
        for (const moduleId in modules) {
            if (Object.prototype.hasOwnProperty.call(modules, moduleId)) {
                const moduleString = modules[moduleId].toString();
                if (moduleString.includes('Connecting WebSocket at ')) {
                    const originalRmsModule = modules[moduleId];
                    modules[moduleId] = function(module, exports, require) {
                        originalRmsModule.apply(this, arguments);
                        window._lolWatcher.rmsSocketManager = module.exports.default;
                        debug('[LoL Watcher] RmsWebSocket manager instance captured for auto-reconnect.');
                    };
                }
            }
        }
    };

    const originalPush = window.webpackJsonp ? window.webpackJsonp.push : [].push;
    const patchedPush = function() { 
        const args = arguments; 
        if (window._lolWatcher.forceFixEnabled && args[0] && args[0][1]) { 
            patchAllModules(args[0][1]); 
        } 
        return originalPush.apply(window.webpackJsonp, args); 
    };
    
    if (window.webpackJsonp) { 
        window.webpackJsonp.push = patchedPush; 
    } else { 
        Object.defineProperty(window, 'webpackJsonp', { 
            configurable: true, 
            set(value) { 
                Object.defineProperty(window, 'webpackJsonp', { value: value, writable: true }); 
                value.push = patchedPush; 
            }, 
            get() { return undefined; } 
        }); 
    }

    window.postMessage({
        type: 'LOL_WATCHER_STATUS',
        status: {
            webSocketPatched: typeof window.WebSocket !== 'undefined' && window.WebSocket !== originalWebSocket,
            fetchPatched: typeof window.fetch !== 'undefined' && window.fetch !== originalFetch,
            webpackPatched: !!(window.webpackJsonp?.push === patchedPush || Object.getOwnPropertyDescriptor(window, 'webpackJsonp')?.set),
            userscriptKilled: typeof window.__disableUserscriptMaster === 'function',
            fakePlayerEnabled: !!window._lolWatcher.fakePlayerEnabled,
            twitchPlayerWrapped: !!(window.Twitch && window.Twitch.Player && window.Twitch.Player.__lolWatcherFakeWrapped),
            ytPlayerWrapped: !!(window.YT && window.YT.Player && window.YT.Player.__lolWatcherFakeWrapped)
        }
    }, '*');

    // Request config from content script (handles race condition with postMessage)
    window.postMessage({ type: 'LOL_WATCHER_REQUEST_CONFIG' }, '*');
})();
