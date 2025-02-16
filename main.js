/********************************************
 * main.js
 ********************************************/

// Core imports
const { app, BrowserWindow, shell } = require("electron");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const crypto = require("crypto");
const log = require("electron-log");
const isElevated = require("is-elevated"); // For checking admin rights on Windows
const { ipcMain } = require("electron");

// Initialize electron-log
log.initialize();
log.transports.file.getFile().path = path.join(app.getPath("userData"), "app.log");

// Our single BrowserWindow reference
let mainWindow = null;
let vpnProcess = null;
let userInitiatedDisconnect = false; // track if disconnect was user-driven

/********************************************
 * Create an Express server
 ********************************************/
const expressApp = express();
const PORT = 38351;
expressApp.use(bodyParser.json());
expressApp.use(express.static(path.join(__dirname, "public"))); 
// => This serves your index.html, app.js, etc. from a "public" folder

// If you store .ovpn in a "configs" folder (like your original code):
const CONFIG_DIR = path.join(process.cwd(), "configs");

// Known possible paths for openvpn.exe
const possibleOpenvpnPaths = [
  "C:\\Program Files\\OpenVPN\\bin\\openvpn.exe",
  "C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe",
];

// Example official or custom link for the OpenVPN MSI (64-bit)
const OPENVPN_INSTALLER_URL = "https://swupdate.openvpn.org/community/releases/OpenVPN-2.6.13-I001-amd64.msi";

/********************************************
 * findOpenVPNExecutable():
 * return the first openvpn.exe found, or null
 ********************************************/
function findOpenVPNExecutable() {
  for (const p of possibleOpenvpnPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/********************************************
 * downloadAndInstallOpenVPN():
 * Download the MSI, run msiexec /i (passive/silent)
 ********************************************/
async function downloadAndInstallOpenVPN() {
  try {
    const elevated = await isElevated();
    if (!elevated) {
      log.warn("We are not running as admin; the MSI might prompt or fail if user denies UAC.");
    }

    const installerPath = path.join(app.getPath("temp"), "openvpn-install.msi");
    log.info("Downloading OpenVPN installer from:", OPENVPN_INSTALLER_URL);

    // 1) Download
    const resp = await axios.get(OPENVPN_INSTALLER_URL, { responseType: "arraybuffer" });
    fs.writeFileSync(installerPath, resp.data);
    log.info("Saved OpenVPN installer to:", installerPath);

    // 2) Spawn msiexec
    const child = spawn("msiexec", ["/i", installerPath, "/passive"], {
      stdio: "inherit"
    });

    return new Promise((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) {
          log.info("OpenVPN installer completed successfully");
          resolve();
        } else {
          log.error("OpenVPN installer failed with code:", code);
          reject(new Error(`Installer exit code: ${code}`));
        }
      });
      child.on("error", (err) => {
        log.error("Error spawning installer:", err);
        reject(err);
      });
    });

  } catch (err) {
    log.error("Error in downloadAndInstallOpenVPN:", err);
    throw err;
  }
}

/********************************************
 * Helper: load/save credentials
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

/********************************************
 * fetchRemoteFileHash(): for updating .ovpn
 ********************************************/
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

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

/********************************************
 * downloadConfigFiles() if needed
 * This might be triggered from preload
 ********************************************/
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
          log.info(`Updating ${name}: File changed. Downloading new version.`);
        }
      } else {
        log.info(`Downloading ${name}: File does not exist locally.`);
      }

      fs.writeFileSync(filePath, remoteFile.data);
      log.info(`Saved config: ${filePath}`);
    }

    return { success: true, message: "Config files downloaded/updated." };
  } catch (err) {
    log.error("Error downloading config files:", err);
    return { success: false, error: err.message };
  }
}

/********************************************
 * Setup Electron <-> Renderer IPC
 ********************************************/
ipcMain.handle("download-configs", async (event, servers) => {
  return await downloadConfigFiles(servers);
});

/********************************************
 * Helper: send messages to renderer
 ********************************************/
function sendToRenderer(channel, data) {
  if (mainWindow) {
    mainWindow.webContents.send(channel, data);
  }
}

/********************************************
 * Express Routes
 ********************************************/

/**
 * GET /api/check-openvpn
 * => { found: boolean, path: string|null }
 */
expressApp.get("/api/check-openvpn", (req, res) => {
  const exePath = findOpenVPNExecutable();
  if (exePath) {
    res.json({ found: true, path: exePath });
  } else {
    res.json({ found: false, path: null });
  }
});

/**
 * POST /api/download-openvpn
 * => attempts to download & run installer
 */
expressApp.post("/api/download-openvpn", async (req, res) => {
  try {
    await downloadAndInstallOpenVPN();
    // Check if installed afterwards
    const exePath = findOpenVPNExecutable();
    if (exePath) {
      res.json({ success: true, path: exePath });
    } else {
      res.json({ success: false, error: "Installer finished, but openvpn.exe not found." });
    }
  } catch (err) {
    res.status(500).json({
      error: err.message || "Failed to install OpenVPN."
    });
  }
});

/**
 * POST /api/save-credentials
 * => store user+pass
 */
expressApp.post("/api/save-credentials", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }
  try {
    saveCredentials(username, password);
    res.json({ success: true, message: "Credentials saved." });
  } catch (err) {
    log.error("Error saving credentials:", err);
    res.status(500).json({ error: "Failed to save credentials." });
  }
});

/**
 * GET /api/check-credentials
 * => { exists: boolean }
 */
expressApp.get("/api/check-credentials", (req, res) => {
  const { username, password } = loadCredentials();
  const exists = Boolean(username && password);
  res.json({ exists });
});

/**
 * GET /api/get-saved-credentials
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
 * => clears credentials
 */
expressApp.post("/api/sign-out", (req, res) => {
  clearCredentials();
  res.json({ success: true, message: "Signed out, credentials cleared." });
});

/**
 * POST /api/connect
 * => spawns openvpn.exe with the chosen config
 * If openvpn.exe not found => tries to install
 */
expressApp.post("/api/connect", async (req, res) => {
  try {
    const { server, username, password } = req.body;

    if (!fs.existsSync(server)) {
      return res.status(400).json({ error: `Configuration file not found: ${server}` });
    }

    let openvpnPath = findOpenVPNExecutable();
    if (!openvpnPath) {
      // Attempt to download/install
      await downloadAndInstallOpenVPN();
      // Check again
      openvpnPath = findOpenVPNExecutable();
      if (!openvpnPath) {
        return res.status(500).json({ error: "OpenVPN not found after installation attempt." });
      }
    }

    // Prepare auth.txt in userData folder
    const userDataPath = app.getPath("userData");
    const authFilePath = path.join(userDataPath, "auth.txt");
    fs.writeFileSync(authFilePath, `${username}\r\n${password}\r\n`, "utf8");
    
    log.info("Spawning OpenVPN with config:", server);

    userInitiatedDisconnect = false;
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
          error: "Authentication failed."
        });
        vpnProcess.kill();
      }
      if (output.includes("Initialization Sequence Completed")) {
        connectionState = "Connected";
        sendToRenderer("connectionStatus", { state: "Connected" });
      }
    });

    vpnProcess.stderr.on("data", (data) => {
      const errOutput = data.toString();
      log.error("VPN stderr:", errOutput);

      if (
        errOutput.includes("AUTH_FAILED") ||
        errOutput.includes("Authentication failed")
      ) {
        connectionState = "Error";
        sendToRenderer("connectionStatus", {
          state: "Error",
          error: "Authentication failed."
        });
        vpnProcess.kill();
      } else {
        // Send any other errors
        sendToRenderer("errorMessage", errOutput);
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

    res.json({ success: true, message: "OpenVPN started." });

  } catch (err) {
    log.error("Error in /api/connect:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/disconnect
 * => kills the VPN process
 */
expressApp.post("/api/disconnect", (req, res) => {
  if (vpnProcess) {
    userInitiatedDisconnect = true;
    vpnProcess.kill();
    vpnProcess = null;
    return res.json({ success: true, message: "Disconnected." });
  }
  res.status(400).json({ error: "No active VPN connection." });
});

/**
 * GET /api/check-updates
 * => compares local version to some remote version
 */
expressApp.get("/api/check-updates", (req, res) => {
  const currentVersion = "1.8"; // Hardcoded example
  const updateUrl = "https://api.node9.dev/ver"; // Example

  axios.get(updateUrl, { responseType: "text" })
    .then((r) => {
      const latestVersion = r.data.trim();
      if (latestVersion > currentVersion) {
        res.json({ updateAvailable: true, latestVersion });
      } else {
        res.json({ updateAvailable: false });
      }
    })
    .catch((err) => {
      res.status(500).json({
        error: "Failed to check for updates",
        details: err.message
      });
    });
});

/**
 * GET /api/openbrowser?url=...
 * => shell.openExternal to open a link
 */
expressApp.get("/api/openbrowser", (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: "Missing url param" });
  }
  shell.openExternal(url)
    .then(() => res.json({ success: true }))
    .catch((err) => res.status(500).json({ error: err.message }));
});

/**
 * GET /api/get-ovpn-files
 * => list available .ovpn in /configs
 */
expressApp.get("/api/get-ovpn-files", (req, res) => {
  if (!fs.existsSync(CONFIG_DIR)) {
    return res.status(404).json({ error: "No configuration folder found." });
  }

  const files = fs.readdirSync(CONFIG_DIR)
    .filter((file) => file.endsWith(".ovpn"));
  
  if (files.length === 0) {
    return res.status(404).json({ error: "No .ovpn files found." });
  }
  res.json({ files });
});

/********************************************
 * Start the Express server
 ********************************************/
expressApp.listen(PORT, () => {
  log.info(`Express server is running at http://localhost:${PORT}`);
});

/********************************************
 * Electron "ready": create the main window
 ********************************************/
app.on("ready", () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
});
