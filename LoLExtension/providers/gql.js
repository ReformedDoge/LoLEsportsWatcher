const GQL_STREAM_FALLBACK = false;

const gqlProvider = {
    id: PROVIDER_GQL,
    name: 'Official LoL API (GraphQL)',
    _scheduleCache: null,
    _scheduleCacheTime: 0,
    _cacheTTL: 60000,
    _streamsCache: {},
    _leagueIdNameMap: {},

    async _op(name, variables) {
        const stored = await chrome.storage.local.get(['gqlTable']);
        const hash = stored.gqlTable?.ops?.[name]?.hash;
        if (!hash) {
            debugLog(`gqlProvider: no hash for ${name}, skipping`);
            return null;
        }
        const client = stored.gqlTable?.client || { name: 'Esports Web', version: '1f05c07' };
        const params = new URLSearchParams({
            operationName: name,
            variables: JSON.stringify(variables),
            extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } })
        });
        const data = await fetchJson(`${GQL_API_BASE}?${params.toString()}`, {
            headers: {
                'x-api-key': OFFICIAL_API_KEY,
                'apollo-require-preflight': 'true',
                'apollographql-client-name': client.name,
                'apollographql-client-version': client.version,
                'content-type': 'application/json'
            }
        });
        if (data?.errors?.length) {
            debugLog(`gqlProvider: ${name} errors: ${JSON.stringify(data.errors).slice(0, 200)}`);
            chrome.storage.local.set({ gqlDrift: { at: Date.now(), detail: `gql ${name} errors` } }).catch(() => {});
            return null;
        }
        return data;
    },

    _toEvent(e) {
        return {
            type: e.type,
            state: e.state,
            startTime: e.startTime,
            league: e.league ? { id: String(e.league.id), name: e.league.name, slug: e.league.slug } : e.league,
            match: e.match ? { id: e.match.id } : undefined,
            tournament: e.tournament ? { id: e.tournament.id } : undefined,
            streams: e.streams || []
        };
    },

    async getSchedule() {
        const now = Date.now();
        if (this._scheduleCache && (now - this._scheduleCacheTime) < this._cacheTTL) {
            return this._scheduleCache;
        }
        this._streamsCache = {};
        const cutoff = Date.now() - 3 * 864e5;
        const day = (t) => new Date(t).toISOString().slice(0, 10);
        let allEvents = [];
        let pageToken = null;
        for (let page = 0; page < 10; page++) {
            const vars = { hl: 'en-GB', sport: ['lol'], pageSize: 100, eventDateStart: day(Date.now() - 3 * 864e5), eventDateEnd: day(Date.now() + 60 * 864e5) };
            if (pageToken) vars.pageToken = pageToken;
            const data = await this._op('scheduleEvents', vars);
            const batch = data?.data?.esports;
            if (!batch?.events) break;
            allEvents = allEvents.concat(batch.events.map(e => this._toEvent(e)));
            pageToken = batch.pages?.older || null;
            if (!pageToken) break;
        }
        allEvents = allEvents.filter(e => {
            if (e.state === 'inProgress' || e.state === 'unstarted') return true;
            const t = e.startTime ? Date.parse(e.startTime) : NaN;
            return !isNaN(t) && t >= cutoff;
        });
        this._scheduleCache = { data: { schedule: { events: allEvents } } };
        this._scheduleCacheTime = now;
        return this._scheduleCache;
    },

    async getLeagues() {
        const data = await this._op('getLeagues', { hl: 'en-GB', sport: ['lol'] });
        const leagueMap = {};
        const idNameMap = {};
        if (data?.data?.leagues) {
            for (const league of data.data.leagues) {
                leagueMap[league.name] = `https://lolesports.com/live/${league.slug}`;
                if (league.id && league.name) {
                    idNameMap[String(league.id)] = league.name.trim();
                }
            }
        }
        this._leagueIdNameMap = idNameMap;
        return { ...FALLBACK_LEAGUE_URL, ...leagueMap };
    },

    async getStreams(leagueName) {
        if (this._streamsCache[leagueName]) {
            return this._streamsCache[leagueName];
        }
        // scheduleEvents may carry streams when live; legacy details rescues
        // when it does not. Unverifiable until a live event either way.
        const schedule = await this.getSchedule();
        const events = schedule?.data?.schedule?.events || [];
        let streams = [];
        const bare = [];
        for (const event of events) {
            if (event.state === 'completed') continue;
            if (event.league?.name?.trim() !== leagueName) continue;
            if (event.streams?.length) streams = streams.concat(event.streams);
            else if (event.match?.id) bare.push(event.match.id);
        }
        for (const matchId of bare) {
            if (!GQL_STREAM_FALLBACK) break;
            try {
                const details = await fetchJson(`${OFFICIAL_API_BASE}/getEventDetails?id=${matchId}&hl=en-US`, {
                    headers: { 'x-api-key': OFFICIAL_API_KEY }
                });
                if (details?.data?.event?.streams) {
                    streams = streams.concat(details.data.event.streams);
                }
            } catch (error) {
                console.error(`Failed to fetch streams for ${matchId}:`, error);
            }
        }
        const result = { streams, hasStreams: streams.length > 0 };
        this._streamsCache[leagueName] = result;
        return result;
    },

    clearCache() {
        this._scheduleCache = null;
        this._streamsCache = {};
    }
};

registerProvider(gqlProvider);
