const NodeHelper = require("node_helper");
const { GarminConnect } = require("garmin-connect");
const { exec } = require('child_process');
const fs = require('fs');

const getLastActivityDate = (activities) => {
  const lastActivity = activities[0];
  const lastStartTimeLocal = lastActivity.startTimeLocal;
  return lastStartTimeLocal;
};

const getDiffActivityDate = (activityDate) => {
  const activityDateDate = new Date(activityDate);
  const today = new Date();
  const diff = Math.round((today - activityDateDate) / (1000 * 60 * 60 * 24));
  return diff;
};

// Standard Google/Mapbox polyline encoding (precision 5), no external dependency needed.
const encodeSignedNumber = (num) => {
  let sgnNum = num << 1;
  if (num < 0) {
    sgnNum = ~sgnNum;
  }
  let output = '';
  while (sgnNum >= 0x20) {
    output += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  output += String.fromCharCode(sgnNum + 63);
  return output;
};

const encodePolyline = (coordinates) => {
  const factor = 1e5;
  let output = '';
  let prevLat = 0;
  let prevLng = 0;
  coordinates.forEach((coord) => {
    const lat = Math.round(coord[1] * factor);
    const lng = Math.round(coord[0] * factor);
    output += encodeSignedNumber(lat - prevLat);
    output += encodeSignedNumber(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  });
  return output;
};

// Keep the URL short: sample down to at most maxPoints, always keeping first/last.
const downsample = (coordinates, maxPoints) => {
  if (coordinates.length <= maxPoints) {
    return coordinates;
  }
  const step = Math.ceil(coordinates.length / maxPoints);
  const sampled = coordinates.filter((_, i) => i % step === 0);
  const last = coordinates[coordinates.length - 1];
  if (sampled[sampled.length - 1] !== last) {
    sampled.push(last);
  }
  return sampled;
};

const buildStaticMapUrl = (geoJsonData, mapboxToken) => {
  const coordinates = geoJsonData?.features?.[0]?.geometry?.coordinates;
  if (!coordinates || coordinates.length < 2 || !mapboxToken) {
    return null;
  }
  const sampled = downsample(coordinates, 150);
  const polyline = encodePolyline(sampled);
  const overlay = `path-4+e63946-1(${encodeURIComponent(polyline)})`;
  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlay}/auto/250x250@2x?padding=30&access_token=${mapboxToken}`;
};

// --- Backoff / circuit-breaker for Garmin logins ---
//
// Garmin's SSO endpoint rate-limits (HTTP 429 / Cloudflare error 1015) if we log in
// too often - which happens easily during development, since every MagicMirror
// restart used to force a fresh login for every configured account. This tracks
// per-account failure state on disk (survives restarts) and skips login attempts
// while an account is in backoff, instead of hammering Garmin again.

const INITIAL_BACKOFF_MS = 60 * 1000; // 60s
const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 min cap
const BACKOFF_STATE_FILE_NAME = '.gconnect-backoff.json';

const loadBackoffState = (dataDir) => {
  try {
    const raw = fs.readFileSync(`${dataDir}/${BACKOFF_STATE_FILE_NAME}`, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
};

const saveBackoffState = (dataDir, state) => {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(`${dataDir}/${BACKOFF_STATE_FILE_NAME}`, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`MMM-GConnect: failed to persist backoff state: ${e}`);
  }
};

const isRateLimitError = (error) => {
  const message = String(error?.message || error || '');
  return message.includes('429') || message.includes('rate_limited') || message.includes('Too Many Requests');
};

module.exports = NodeHelper.create({
  clients: {}, // loginName -> logged-in GarminConnect instance, reused across requests
  backoffState: {}, // loginName -> { nextAttemptAt, backoffMs, consecutiveFailures }

  start: function () {
    console.info("MMM-GConnect started!");
    this.dataDir = `${this.path}/data`;
    this.backoffState = loadBackoffState(this.dataDir);
  },

  getClient: async function (loginName, password) {
    if (this.clients[loginName]) {
      return this.clients[loginName];
    }
    const client = new GarminConnect();
    await client.login(loginName, password);
    this.clients[loginName] = client;
    return client;
  },

  recordSuccess: function (loginName) {
    delete this.backoffState[loginName];
    saveBackoffState(this.dataDir, this.backoffState);
  },

  recordFailure: function (loginName) {
    const prev = this.backoffState[loginName];
    const nextBackoffMs = Math.min(
      prev ? prev.backoffMs * 2 : INITIAL_BACKOFF_MS,
      MAX_BACKOFF_MS
    );
    this.backoffState[loginName] = {
      nextAttemptAt: Date.now() + nextBackoffMs,
      backoffMs: nextBackoffMs,
      consecutiveFailures: (prev?.consecutiveFailures || 0) + 1,
    };
    saveBackoffState(this.dataDir, this.backoffState);
    // A failed login likely means the cached client's session is bad - drop it
    // so the next allowed attempt logs in fresh rather than reusing a dead session.
    delete this.clients[loginName];
  },

  isInBackoff: function (loginName) {
    const state = this.backoffState[loginName];
    return !!state && Date.now() < state.nextAttemptAt;
  },

  socketNotificationReceived: async function (notification, payload) {
    const self = this;
    switch (notification) {
      case "GET_GARMIN_DATA": {
        const loginName = payload.loginName;

        if (self.isInBackoff(loginName)) {
          const state = self.backoffState[loginName];
          const secondsLeft = Math.ceil((state.nextAttemptAt - Date.now()) / 1000);
          console.info(`MMM-GConnect: skipping login for ${loginName}, in backoff for another ${secondsLeft}s (failure #${state.consecutiveFailures})`);
          return;
        }

        try {
          const GCClient = await self.getClient(loginName, payload.password);
          const activities = await GCClient.getActivities(0, 1);
          const lastActivityDate = getLastActivityDate(activities);
          const lastActivityDistance =
            Math.round((activities[0].distance / 1000) * 100) / 100;
          const lastActivityTime =
            Math.round((activities[0].duration / 60) * 100) / 100;
          const lastActivityAvgSpeed =
            Math.round(activities[0].averageSpeed * 100) / 100;
          const lastActivityAvgHR =
            Math.round(activities[0].averageHR * 100) / 100;
          const diff = getDiffActivityDate(lastActivityDate);
          const activityType = activities[0].activityName;
          const showMap = payload?.showMap || false;

          self.recordSuccess(loginName);

          if (showMap) {
            const mapboxToken = payload?.mapboxToken;
            await GCClient.downloadOriginalActivityData({ activityId: activities[0].activityId }, `${self.path}/data`, 'tcx');

            const arch = process.arch;
            const isArm = arch.startsWith('arm') || arch === 'arm64';

            exec(`${self.path}/bin/tcx-ls${isArm ? '-arm' : ''} ${self.path}/data/${activities[0].activityId}.tcx --geojson ${self.path}/data/${activities[0].activityId}.json`, (error, _, stderr) => {
                if (error) {
                  console.error(`Error executing tcx-ls: ${error}`);
                  return;
                }
                if (stderr) console.error(`Command stderr: ${stderr}`);

                const jsonFilePath = `${self.path}/data/${activities[0].activityId}.json`;
                if (!fs.existsSync(jsonFilePath)) {
                  console.error(`GeoJSON file not found: ${jsonFilePath}`);
                  return;
                }

                try {
                  const geoJsonData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
                  const mapImageUrl = buildStaticMapUrl(geoJsonData, mapboxToken);

                  self.sendSocketNotification("UPDATE_GARMIN_DATA", {
                    identifier: payload.identifier,
                    diff,
                    lastActivityDistance,
                    lastActivityTime,
                    lastActivityAvgSpeed,
                    lastActivityAvgHR,
                    activityType,
                    mapImageUrl,
                    showMap,
                  });
              } catch (parseError) {
                console.error(`Error reading or parsing JSON file: ${parseError}`);
              }
            });
           } else {
            self.sendSocketNotification("UPDATE_GARMIN_DATA", {
              identifier: payload.identifier,
              diff,
              lastActivityDistance,
              lastActivityTime,
              lastActivityAvgSpeed,
              lastActivityAvgHR,
              activityType,
              showMap,
            });
          }
        } catch (error) {
          self.recordFailure(loginName);
          const state = self.backoffState[loginName];
          if (isRateLimitError(error)) {
            console.error(`MMM-GConnect: rate-limited logging in as ${loginName}. Backing off for ${Math.round(state.backoffMs / 1000)}s (failure #${state.consecutiveFailures}).`);
          } else {
            console.error(`MMM-GConnect: error fetching data for ${loginName}: ${error}. Backing off for ${Math.round(state.backoffMs / 1000)}s (failure #${state.consecutiveFailures}).`);
          }
        }

        break;
      }
      default:
        console.error("Switch item {} is missing", notification);
    }
  },
});
