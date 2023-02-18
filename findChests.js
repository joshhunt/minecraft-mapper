import fs from "fs-extra";
import * as turf from "@turf/turf";

function pointInPolygonNested(point, vs, start, end) {
  var x = point[0],
    y = point[1];
  var inside = false;
  if (start === undefined) start = 0;
  if (end === undefined) end = vs.length;
  var len = end - start;
  for (var i = 0, j = len - 1; i < len; j = i++) {
    var xi = vs[i + start][0],
      yi = vs[i + start][1];

    var xj = vs[j + start][0],
      yj = vs[j + start][1];

    var intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }
  return inside;
}

const itemGeojsonFile = (
  await fs.readFile("./output/joshcraft/output.geojson")
).toString();

const fnsrc = `
  ${itemGeojsonFile}
  return geojson;
`;

const fn = new Function(fnsrc);
const geojson = fn();
const features = geojson.features;

// var searchWithin = turf.polygon([
//   [
//     [333, 2],
//     [345, 3],
//     [345, 17],
//     [333, 18],
//     [333, 2],
//   ],
// ]);

// const ptsWithin = turf.pointsWithinPolygon(features, searchWithin);
// console.log(ptsWithin);

const [boundsStart, boundsEnd] = [
  [333, 64, 2],
  [345, 66, 18],
];

const boundsXMin = Math.min(boundsStart[0], boundsEnd[0]);
const boundsYMin = Math.min(boundsStart[1], boundsEnd[1]);
const boundsZMin = Math.min(boundsStart[2], boundsEnd[2]);

const boundsXMax = Math.max(boundsStart[0], boundsEnd[0]);
const boundsYMax = Math.max(boundsStart[1], boundsEnd[1]);
const boundsZMax = Math.max(boundsStart[2], boundsEnd[2]);

const foundPoints = features.filter((feature) => {
  const [x, y, z] = feature.properties.Pos;
  const isInside =
    x < boundsXMin ||
    x > boundsXMax ||
    y < boundsYMin ||
    y > boundsYMax ||
    z < boundsZMin ||
    z > boundsZMax
      ? false
      : true;
  return feature.properties.Name === "Chest" && isInside;
});

console.log(`Found ${foundPoints.length} chests`);

let items = {};

for (const chest of foundPoints) {
  console.log(
    `  ${chest.properties.Pos.join(", ")}: ${
      (chest.properties.Items ?? []).length
    } items`
  );

  if (!chest.properties.Items) continue;

  for (const itemStack of chest.properties.Items) {
    if (!items[itemStack.Name]) {
      items[itemStack.Name] = 0;
    }

    items[itemStack.Name] += Number(itemStack.Count);
  }
}

const sortList = [
  // "button",
  // "door",
  // "trapdoor",

  "nether",
  "sand",
  "nether",
  "blackstone",
  "stone",
  "gravel",

  "dark oak",
  "oak",
  "spruce",
  "birch",
  "jungle",
  "acacia",
  "crimson hyphae",
  "warped hyphae",

  "copper",
  "iron",
  "gold",
  "diamond",
];

items = Object.entries(items)
  .map((v) => ({ item: v[0], quantity: v[1] }))
  .sort((a, b) => {
    const scoreA = sortList.findIndex((v) => a.item.toLowerCase().includes(v));
    const scoreB = sortList.findIndex((v) => b.item.toLowerCase().includes(v));

    var orderResult = scoreB - scoreA;
    var quantityResult = b.quantity - a.quantity;

    if (orderResult !== 0) {
      return orderResult;
    }

    return quantityResult;
  });

const totalStacks = items.reduce((acc, item) => {
  return acc + Math.ceil(item.quantity / 64);
}, 0);

console.log(items);
console.log(
  `${items.length} unique items requiring ${totalStacks} chest spots`
);
