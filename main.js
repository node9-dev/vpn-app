/********************************************
 * main.js
 ********************************************/
const { app, BrowserWindow } = require("electron");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { shell } = require('electron');
const axios = require("axios");
const crypto = require("crypto");
const log = require("electron-log");

log.initialize();
log.transports.file.path = 'D:\\Node9 New Project\\node9-vpn-app\\app.log';

let mainWindow = null;
let vpnProcess = null;

// Distinguish user-initiated disconnect from unexpected exit
let userInitiatedDisconnect = false;

// Initialize the Express server
const expressApp = express();
const PORT = 38351;

const CONFIG_DIR = path.join(process.cwd(), "configs"); 

expressApp.use(bodyParser.json());
expressApp.use(express.static(path.join(__dirname, "public")));


function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);

      stream.on("data", (data) => hash.update(data));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", (err) => reject(err));
  });
}

async function fetchRemoteFileHash(url) {
  try {
      const response = await axios.get(url, { responseType: "arraybuffer" });
      const hash = crypto.createHash("sha256").update(response.data).digest("hex");
      return { hash, data: response.data };
  } catch (error) {
      log.error("Error fetching remote hash:", error);
      return null;
  }
}

/********************************************
 * Helper Functions: Load/Save Credentials
 ********************************************/
function loadCredentials() {
  if (fs.existsSync("credentials.json")) {
    const data = fs.readFileSync("credentials.json", "utf8");
    return JSON.parse(data);
  }
  return { username: "", password: "" };
}

function saveCredentials(username, password) {
  fs.writeFileSync("credentials.json", JSON.stringify({ username, password }), "utf8");
}

function clearCredentials() {
  fs.writeFileSync("credentials.json", JSON.stringify({ username: "", password: "" }), "utf8");
}


async function downloadConfigFiles(serverURLs) {
  try {
      if (!fs.existsSync(CONFIG_DIR)) {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }

      for (const { name, url } of serverURLs) {
          const filePath = path.join(CONFIG_DIR, `${name}.ovpn`);
          log.info(`Checking config: ${filePath}`);

          const remoteFile = await fetchRemoteFileHash(url);
          if (!remoteFile) continue; 

          const remoteHash = remoteFile.hash;

          if (fs.existsSync(filePath)) {
              const localHash = await computeFileHash(filePath);
              if (localHash === remoteHash) {
                  log.info(`Skipping ${name}: File is up to date.`);
                  continue; 
              } else {
                  log.info(`Updating ${name}: File has changed.`);
              }
          } else {
              log.info(`Downloading ${name}: File does not exist.`);
          }

          fs.writeFileSync(filePath, remoteFile.data);
          log.info(`Config saved: ${filePath}`);
      }

      return { success: true, message: "Config files downloaded/updated successfully." };
  } catch (error) {
      log.error("Error downloading config files:", error);
      return { success: false, error: error.message };
  }
}

/********************************************
 * IPC Helper
 ********************************************/
function sendToRenderer(channel, message) {
  if (mainWindow) {
    mainWindow.webContents.send(channel, message);
  }
}

const { ipcMain } = require("electron");

ipcMain.handle("download-configs", async (event, servers) => {
    return await downloadConfigFiles(servers);
});


/********************************************
 * Express API Routes
 ********************************************/

/** 
 * POST /api/save-credentials 
 * Save {username, password} to credentials.json
 */
expressApp.post("/api/save-credentials", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }
  try {
    saveCredentials(username, password);
    res.json({ success: true, message: "Credentials saved successfully." });
  } catch (err) {
    log.error("Error saving credentials:", err);
    res.status(500).json({ error: "Failed to save credentials." });
  }
});

/**
 * GET /api/check-credentials
 * Return {exists: true} if credentials.json has username + password
 */
expressApp.get("/api/check-credentials", (req, res) => {
  const { username, password } = loadCredentials();
  if (username && password) {
    res.json({ exists: true });
  } else {
    res.json({ exists: false });
  }
});

/**
 * GET /api/get-saved-credentials
 * Return {username, password} if found, or 404 if none
 */
expressApp.get("/api/get-saved-credentials", (req, res) => {
  const { username, password } = loadCredentials();
  if (!username || !password) {
    return res.status(404).json({ error: "No credentials found" });
  }
  res.json({ username, password });
});

/**
 * POST /api/sign-out
 * Clears credentials
 */
expressApp.post("/api/sign-out", (req, res) => {
  clearCredentials();
  res.json({ success: true, message: "Signed out. Credentials cleared." });
});

/**
 * POST /api/connect
 * Writes username/password to auth.txt, spawns OpenVPN
 */
expressApp.post("/api/connect", (req, res) => {
  const { server, username, password } = req.body;

  if (!fs.existsSync(server)) {
    return res.status(400).json({ error: "Configuration file not found." });
  }

  const openvpnPath = "C:\\Program Files\\OpenVPN\\bin\\openvpn.exe";
  if (!fs.existsSync(openvpnPath)) {
    return res.status(400).json({ error: "OpenVPN executable not found." });
  }

  // Write user/pass to auth.txt
  // insecure but works for now
  const authFilePath = path.join(__dirname, "auth.txt");
  fs.writeFileSync(authFilePath, `${username}\r\n${password}\r\n`, "utf8");

  userInitiatedDisconnect = false;

  //spawns vpn process and parses app info into it
  vpnProcess = spawn(openvpnPath, [
    "--config",
    server,
    "--auth-user-pass",
    authFilePath,
  ]);

  let connectionState = "Disconnected";

  vpnProcess.stdout.on("data", (data) => {
    const output = data.toString();


    log.info("VPN stdout:", output);

    if (output.includes("Peer Connection Initiated")) {
      connectionState = "Connecting";
      sendToRenderer("connectionStatus", { state: "Connecting" });
    }
    if (output.includes("AUTH_FAILED")) {
      connectionState = "Error";
      sendToRenderer("connectionStatus", {
        state: "Error",
        error: "Authentication failed.",
      });
      vpnProcess.kill();
    }
    if (output.includes("Initialization Sequence Completed")) {
      connectionState = "Connected";
      sendToRenderer("connectionStatus", { state: "Connected" });
    }
  });

  vpnProcess.stderr.on("data", (data) => {
    const errorOutput = data.toString();
    log.error("VPN stderr:", errorOutput);

    if (
      errorOutput.includes("AUTH_FAILED") ||
      errorOutput.includes("Authentication failed")
    ) {
      connectionState = "Error";
      sendToRenderer("connectionStatus", {
        state: "Error",
        error: "Authentication failed. Please check your credentials.",
      });
      vpnProcess.kill();
    } else {
      sendToRenderer("errorMessage", errorOutput);
    }
  });

  vpnProcess.on("exit", (code) => {
    log.info("VPN process exited with code:", code);

    if (connectionState === "Error") {
      return;
    }
    if (userInitiatedDisconnect) {
      sendToRenderer("connectionStatus", { state: "Disconnected" });
      userInitiatedDisconnect = false;
      return;
    }
    if (code !== 0) {
      sendToRenderer("connectionStatus", {
        state: "Error",
        error: `Process exited with code ${code}`,
      });
    } else {
      sendToRenderer("connectionStatus", { state: "Disconnected" });
    }
  });

  res.json({ success: true, message: "OpenVPN process started successfully." });
});

/**
 * POST /api/disconnect
 * Kills the VPN process => "Disconnected"
 */

expressApp.post("/api/disconnect", (req, res) => {
  if (vpnProcess) {
    userInitiatedDisconnect = true;
    vpnProcess.kill();
    vpnProcess = null;
    res.json({ success: true, message: "Disconnected successfully" });
  } else {
    res.status(400).json({ error: "No active VPN connection to disconnect" });
  }
});

/**
 * GET /api/check-updates
*/

expressApp.get("/api/check-updates", (req, res) => {
  const currentVersion = "2";
  const updateUrl = "https://api.node9.dev/ver";

  fetch(updateUrl)
    .then((r) => r.text())
    .then((latestVersion) => {
      if (latestVersion > currentVersion) {
        res.json({ updateAvailable: true, latestVersion });
      } else {
        res.json({ updateAvailable: false });
      }
    })
    .catch((err) => {
      res.status(500).json({
        error: "Failed to check for updates",
        details: err.message || err,
      });
    });
});

expressApp.get("/api/openbrowser", (req, res) => {
  const { url } = req.query; 

  if (!url) {
      return res.status(400).json({ error: "Missing URL parameter" });
  }

  shell.openExternal(url) 
      .then(() => res.json({ success: true }))
      .catch(err => res.status(500).json({ error: err.message }));
});

/**
 * GET /api/get-ovpn-files
 * Lists .ovpn in /configs folder
 */
expressApp.get("/api/get-ovpn-files", (req, res) => {
  const ovpnFolder = path.join(__dirname, "configs");
  if (!fs.existsSync(ovpnFolder)) {
    return res.status(404).json({ error: "No configuration folder found." });
  }

  const files = fs
    .readdirSync(ovpnFolder)
    .filter((file) => file.endsWith(".ovpn"));

  if (files.length === 0) {
    return res.status(404).json({ error: "No .ovpn files found in the folder." });
  }

  res.json({ files });
});

/********************************************
 * Start Express
 ********************************************/
expressApp.listen(PORT, () => {
  log.info(`Express server is running at http://localhost:${PORT}`);
});

/********************************************
 * Electron App
 ********************************************/
app.on("ready", () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    frame: true,
    resizable: false,
    autoHideMenuBar: true,

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,  
      contextIsolation: true,
      enableRemoteModule: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
});
