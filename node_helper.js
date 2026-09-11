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

module.exports = NodeHelper.create({
  start: function () {
    console.info("MMM-GConnect started!");
  },
  socketNotificationReceived: async function (notification, payload) {
    const self = this;
    switch (notification) {
      case "GET_GARMIN_DATA":
        const GCClient = new GarminConnect();
        await GCClient.login(payload.loginName, payload.password);
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

        if (showMap) {
          const mapboxToken = payload?.mapboxToken;
          await GCClient.downloadOriginalActivityData({ activityId: activities[0].activityId }, `${this.path}/data`, 'tcx');

          const arch = process.arch;
          const isArm = arch.startsWith('arm') || arch === 'arm64';

          exec(`${this.path}/bin/tcx-ls${isArm ? '-arm' : ''} ${this.path}/data/${activities[0].activityId}.tcx --geojson ${this.path}/data/${activities[0].activityId}.json`, (error, _, stderr) => {
              if (error) {
                console.error(`Error executing tcx-ls: ${error}`);
                return;
              }
              if (stderr) console.error(`Command stderr: ${stderr}`);

              const jsonFilePath = `${this.path}/data/${activities[0].activityId}.json`;
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

        break;
      default:
        console.error("Switch item {} is missing", notification);
    }
  },
});
