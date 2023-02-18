import inquirer from "inquirer";
import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { spawn } from "child_process";
import dotenv from "dotenv";
import S3SyncClient from "s3-sync-client";
import mime from "mime-types";
import cliProgress from "cli-progress";
import lodash from "lodash";

const TransferMonitor = S3SyncClient.TransferMonitor;

dotenv.config();

const DEBUG = false;

const MINECRAFT_DIR_LOCATION =
  "C:\\Users\\josh\\AppData\\Local\\Packages\\Microsoft.MinecraftUWP_8wekyb3d8bbwe\\LocalState\\games\\com.mojang\\minecraftWorlds";

const OUTPUT_BASE_DIRECTORY = "C:\\Users\\josh\\dev\\minecraft-mapper\\output";

const BEDROCK_VIZ_EXE = path.resolve(
  path.join(".", "bedrock-viz", "bedrock-viz.exe")
);

const UNMINED_EXE = path.resolve(path.join(".", "unmined", "unmined-cli.exe"));

const worldDirListing = await fs.readdir(MINECRAFT_DIR_LOCATION, {
  withFileTypes: true,
});

const worlds = [];

const choice = (name, value) => ({ name, value: value ?? name });

function getOutputFolderFromWorld(world) {
  const worldName = world.name.toLowerCase();
  if (worldName.includes("joshcraft")) {
    return "joshcraft";
  }

  if (worldName.includes("evadre")) {
    return "evadre";
  }

  return "unknown";
}

async function getWorldDetails(worldPath, folderName) {
  const stat = await fs.stat(worldPath);

  const createdDate = stat.birthtime;

  const levelNamePath = path.join(worldPath, "levelname.txt");
  const levelName = (await fs.readFile(levelNamePath)).toString();

  return {
    name: levelName,
    folderName: folderName,
    worldPath,
    createdDate,
  };
}

for (const folder of worldDirListing) {
  if (!folder.isDirectory()) continue;
  const worldPath = path.join(MINECRAFT_DIR_LOCATION, folder.name);
  worlds.push(await getWorldDetails(worldPath, folder.name));
}

worlds.sort((a, b) => b.createdDate - a.createdDate);

if (process.argv.length === 3) {
  const adhocWorldPath = process.argv[2];
  worlds.unshift(await getWorldDetails(adhocWorldPath, ""));
}

const Q_WORLD = "$world";
const Q_RENDERER = "$renderer";
const Q_BVIZ_HTML = "$bedrockVizHtml";
const Q_UNMD_ZOOM = "$unminedZoom";
const Q_OUTPUT_DIR = "$outputDir";
const Q_S3_DIR = "$s3Dir";
const Q_QUICKIE = "$quickie";

const RENDERER_BEDROCK_VIZ = "bedrock-viz";
const RENDERER_UNMINED = "unmined";

const DIMENSION_OVERWORLD = "overworld";
const DIMENSION_NETHER = "nether";
const DIMENSION_END = "end";

const worldQuestion = {
  type: "list",
  name: Q_WORLD,
  message: "Select a world",
  choices: worlds.map((v) => ({
    name:
      v.name +
      " " +
      chalk.gray(
        `(created ${v.createdDate.toLocaleDateString()} ${v.createdDate.toLocaleTimeString(
          [],
          { timeStyle: "short", hour12: true }
        )})`
      ),
    value: v,
  })),
};

const rendererQuestion = {
  type: "list",
  name: Q_RENDERER,
  message: "Which renderer?",
  default: RENDERER_UNMINED,
  choices: [
    choice("Unmined", RENDERER_UNMINED),
    choice("Bedrock Viz", RENDERER_BEDROCK_VIZ),
  ],
};

const bedrockVizHtmlQuestion = {
  type: "list",
  name: Q_BVIZ_HTML,
  message: "Select HTML depth",
  default: "--html-most",
  when: (wip) => wip[Q_RENDERER] === RENDERER_BEDROCK_VIZ,
  choices: [
    choice("Basic", "--html"),
    choice("Most", "--html-most"),
    choice("All", "--html-all"),
  ],
};

const unminedZoomLevelsQuestion = {
  type: "list",
  name: Q_UNMD_ZOOM,
  message:
    "Select zoom levels (higher values allows closer zoom-in, but takes exponentially more time)",
  default: "3",
  choices: [choice("0"), choice("1"), choice("2"), choice("3")],
  when: (wip) => wip[Q_RENDERER] === RENDERER_UNMINED,
};

const outputQuestion = {
  type: "input",
  name: Q_OUTPUT_DIR,
  message: "Output directory",
  default: (wip) => getOutputFolderFromWorld(wip[Q_WORLD]),
};

const s3DirQuestion = {
  type: "input",
  name: Q_S3_DIR,
  message: "S3 directory",
  default: (wip) => {
    return `${wip[Q_RENDERER]}/${wip[Q_OUTPUT_DIR]}`;
  },
};

const quickieQuestion = {
  type: "list",
  name: Q_QUICKIE,
  message: "Quickie? (Only overworld, no S3)",
  default: false,
  choices: [choice("Yes", true), choice("No", false)],
};

const promptAnswers = await inquirer.prompt([
  worldQuestion,
  rendererQuestion,
  bedrockVizHtmlQuestion,
  unminedZoomLevelsQuestion,
  outputQuestion,
  s3DirQuestion,
  quickieQuestion,
]);

class Deferred {
  constructor() {
    this.promise = new Promise((_resolve, _reject) => {
      this.resolve = _resolve;
      this.reject = _reject;
    });
  }
}

async function exec(exe, command) {
  console.log(`\nExecuting: ${exe} ${command.join(" ")}\n`);

  const baseName = path.basename(exe);
  const childProcess = spawn(exe, command);

  const dfd = new Deferred();

  childProcess.stdout.on("data", (data) => {
    process.stdout.write(data);
  });

  childProcess.stderr.on("data", (data) => {
    process.stderr.write("ERROR: " + data);
  });

  childProcess.on("close", (code) => {
    if (code !== 0) {
      const err = new Error(`${baseName} failed with exit code ` + code);
      dfd.reject(err);
    } else {
      dfd.resolve(code);
    }
  });

  return await dfd.promise;
}

function getOutputDir(answers) {
  return path.join(
    OUTPUT_BASE_DIRECTORY,
    answers[Q_RENDERER],
    answers[Q_OUTPUT_DIR]
  );
}

async function execBedrockViz(answers) {
  const $outputDir = getOutputDir(answers);

  const command = [
    `--db`,
    answers[Q_WORLD].worldPath,
    `--outdir`,
    $outputDir,
    answers[Q_BVIZ_HTML],
    DEBUG && "--shortrun",
  ].filter(Boolean);

  return exec(BEDROCK_VIZ_EXE, command);
}

async function execUnminedDimension(answers, dimension) {
  const outputBase = getOutputDir(answers);
  const $outputDir = path.join(outputBase, dimension);

  const command = [
    `web`,
    "render",
    `--world=${answers[Q_WORLD].worldPath}`,
    `--output=${$outputDir}`,
    "--shadows=true",
    `--zoomin=${answers[Q_UNMD_ZOOM]}`,
    "--imageformat=png",
    `--dimension=${dimension}`,
    dimension === DIMENSION_NETHER && "--topY=75",
    dimension === DIMENSION_NETHER && "--background=#3C2B28",
    dimension === DIMENSION_END && "--background=#040608",
    DEBUG && `--area=c(-13,-10,50,26)`,
    DEBUG && `--force`,
  ].filter(Boolean);

  const result = await exec(UNMINED_EXE, command);

  console.log("Copying custom JS");
  const customOpenLayersJs = path.join(".", "custom", "unmined.openlayers.js");
  const customOpenLayersJsDest = path.join($outputDir, "unmined.openlayers.js");
  await fs.copyFile(customOpenLayersJs, customOpenLayersJsDest);

  return result;
}

async function execUnmined(answers) {
  const customBlockStyles = path.join(".", "custom", "custom.blockstyles.txt");
  const customBlockStylesDest = path.join(
    ".",
    "unmined",
    "config",
    "custom.blockstyles.txt"
  );
  await fs.copyFile(customBlockStyles, customBlockStylesDest);

  const dimensions = answers[Q_QUICKIE]
    ? [DIMENSION_OVERWORLD]
    : [DIMENSION_OVERWORLD, DIMENSION_NETHER, DIMENSION_END];

  for (const dimension of dimensions) {
    await execUnminedDimension(answers, dimension);
  }

  const outputBase = getOutputDir(answers);
  const customOpenLayersJs = path.join(".", "custom", "unmined-index.html");
  const customOpenLayersJsDest = path.join(outputBase, "index.html");
  await fs.copyFile(customOpenLayersJs, customOpenLayersJsDest);
}

switch (promptAnswers[Q_RENDERER]) {
  case RENDERER_BEDROCK_VIZ:
    await execBedrockViz(promptAnswers);
    break;

  case RENDERER_UNMINED:
    await execUnmined(promptAnswers);
    break;

  default:
    throw new Error(`Unhandled renderer ${promptAnswers[Q_RENDERER]}`);
}

if (!promptAnswers[Q_QUICKIE]) {
  console.log(`\nSyncing to S3 at ${promptAnswers[Q_S3_DIR]}`);

  let hasStarted = false;
  const progressBar = new cliProgress.SingleBar(
    { etaBuffer: 500 },
    cliProgress.Presets.shades_classic
  );
  const monitor = new TransferMonitor();

  function logProgress(progress) {
    if (!hasStarted) {
      progressBar.start(progress.size.total, progress.size.current);
      hasStarted = true;
    } else {
      progressBar.update(progress.size.current);
    }
  }

  const throttledLogProgress = lodash.throttle(logProgress, 500, {
    leading: true,
    trailing: true,
  });

  monitor.on("progress", (progress) => {
    throttledLogProgress(progress);
  });

  const client = new S3SyncClient({
    region: "eu-west-1",
    credentials: {
      accessKeyId: process.env.ACCESS_KEY_ID,
      secretAccessKey: process.env.SECRET_ACCESS_KEY,
    },
  });

  const $outputDir = getOutputDir(promptAnswers);

  await client.sync(
    $outputDir,
    `s3://j-minecraft-maps/${promptAnswers[Q_S3_DIR]}`,
    {
      monitor,
      del: true,
      commandInput: {
        ACL: "public-read",
        ContentType: (syncCommandInput) =>
          mime.lookup(syncCommandInput.Key) || "text/html",
      },
    }
  );

  progressBar.stop();
  console.log("Finished uploading to S3");
}
