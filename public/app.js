
/********************************************
 * app.js
 ********************************************/
let isConnected = false;
let connectedTimeInterval = null;
let connectedSeconds = 0;

/********************************************
 * Connect / Disconnect
 ********************************************/
function toggleConnection() {
  if (!isConnected) {
    connect();
  } else {
    disconnect();
  }
}

function openBrowser(url) {
  fetch(`/api/openbrowser?url=${encodeURIComponent(url)}`)
      .then(response => response.json())
      .then(data => {
          if (data.success) {
              console.log("Browser opened successfully.");
          } else {
              console.error("Failed to open browser:", data.error);
          }
      })
      .catch(error => console.error("Error:", error));
}


function connect() {
  const serverDropdown = document.getElementById("server-dropdown");
  const server = serverDropdown.value;

  if (!server) {
    document.getElementById("output").textContent = "Please select a server.";
    return;
  }

  // Load credentials from credentials.json\

  // This is not for VPN auth purely just app
  fetch("/api/get-saved-credentials")
    .then((response) => {
      if (!response.ok) {
        throw new Error("No saved credentials or error retrieving them.");
      }
      return response.json();
    })
    .then(({ username, password }) => {
      if (!username || !password) {
        document.getElementById("output").textContent =
          "No saved credentials found. Please log in first.";
        return;
      }

      // Immediately show "Connecting..."
      document.getElementById("status-text").textContent = "Connecting...";
      document.getElementById("status-text").style.color = "#f5c957";
      document.getElementById("status-text").style.backgroundColor =
        "rgba(245,201,87,0.1)";

      // Hit the /api/connect route
      fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server, username, password }),
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error("Failed to connect to the VPN.");
          }
          return response.json();
        })
        .then(() => {
          // We'll get final "Connected" or "Error" from the connectionStatus event
        })
        .catch((err) => {
          document.getElementById("output").textContent =
            "Error: " + err.message;
          document.getElementById("status-text").textContent = "Disconnected";
          document.getElementById("status-text").style.color = "#bbb";
          document.getElementById("status-text").style.backgroundColor =
            "rgba(255,255,255,0.05)";
        });
    })
    .catch((err) => {
      document.getElementById("output").textContent =
        "Error loading credentials: " + err.message;
    });
}

function disconnect() {
  document.getElementById("status-text").textContent = "Disconnecting...";
  document.getElementById("status-text").style.color = "#f5c957";
  document.getElementById("status-text").style.backgroundColor =
    "rgba(245,201,87,0.1)";

  fetch("/api/disconnect", { method: "POST" })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Failed to disconnect from the VPN.");
      }
      return response.json();
    })
    .then((data) => {
      document.getElementById("output").textContent =
        data.message || "Disconnected successfully!";
      document.getElementById("status-text").textContent = "Disconnected";
      document.getElementById("status-text").style.color = "#bbb";
      document.getElementById("status-text").style.backgroundColor =
        "rgba(255,255,255,0.05)";
      isConnected = false;
      updateUIState();
    })
    .catch((err) => {
      document.getElementById("output").textContent =
        "Error: " + err.message;
    });
}

/********************************************
 * Timer: Connected Time
 ********************************************/
function startConnectedTimeTimer() {
  if (connectedTimeInterval) {
    clearInterval(connectedTimeInterval);
  }
  connectedSeconds = 0;
  updateConnectedTimeDisplay(0);

  connectedTimeInterval = setInterval(() => {
    connectedSeconds++;
    updateConnectedTimeDisplay(connectedSeconds);
  }, 1000);
}

function stopConnectedTimeTimer() {
  if (connectedTimeInterval) {
    clearInterval(connectedTimeInterval);
    connectedTimeInterval = null;
  }
  connectedSeconds = 0;
  updateConnectedTimeDisplay(0);
}

function updateConnectedTimeDisplay(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const hh = h < 10 ? "0" + h : h;
  const mm = m < 10 ? "0" + m : m;
  const ss = s < 10 ? "0" + s : s;
  document.getElementById("connected-time").textContent = `${hh}:${mm}:${ss}`;
}

/********************************************
 * UI State, Populate Servers
 ********************************************/
function updateUIState() {
  const powerCircle = document.getElementById("power-circle");
  if (isConnected) {
    powerCircle.classList.remove("disconnected");
    powerCircle.classList.add("connected");
  } else {
    powerCircle.classList.remove("connected");
    powerCircle.classList.add("disconnected");
  }
}

function populateServerDropdown() {
  fetch("/api/get-ovpn-files")
    .then((response) => response.json())
    .then((data) => {
      const dropdown = document.getElementById("server-dropdown");
      dropdown.innerHTML = '<option value="">Select a server</option>';

      data.files.forEach((file) => {
        const option = document.createElement("option");
        option.value = `configs/${file}`;
        option.textContent = file.replace(".ovpn", "");
        dropdown.appendChild(option);
      });
    })
    .catch((err) => {
      console.error("Error fetching .ovpn files:", err);
      document.getElementById("output").textContent =
        "Error loading server list.";
    });
}

/********************************************
 * Check Credentials
 ********************************************/
function checkCredentials() {
  fetch("/api/check-credentials")
    .then((response) => response.json())
    .then((data) => {
      if (data.exists) {
        document.getElementById("login-page").classList.add("hidden");
        updateUIState();
      } else {
        document.getElementById("login-page").classList.remove("hidden");
      }
    })
    .catch((err) => {
      console.error("Error checking credentials:", err);
    });
}

/********************************************
 * Login Form
 ********************************************/
document.getElementById("login-form").addEventListener("submit", function (e) {
  e.preventDefault();

  const username = document.getElementById("login-username").value;
  const password = document.getElementById("login-password").value;
  const loginMessage = document.getElementById("login-message");
  const loginButton = document.getElementById("login-button");

  loginButton.innerHTML = '<span class="spinner"></span>';
  loginButton.disabled = true;

  // Example external API check
  fetch("https://vpn.node9.dev/api/1.2/auth/loader.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.status === "success") {
        loginMessage.textContent = data.message;
        loginMessage.style.color = "#4caf50";
        // Save credentials in credentials.json
        saveCredentials(username, password);
        setTimeout(() => {
          document.getElementById("login-page").classList.add("hidden");
        }, 1000);
      } else {
        loginMessage.textContent = data.message;
        loginMessage.style.color = "#f44336";
      }
    })
    .catch(() => {
      loginMessage.textContent = "Network error. Please try again.";
      loginMessage.style.color = "#f44336";
    })
    .finally(() => {
      loginButton.innerHTML = "Login";
      loginButton.disabled = false;
    });
});


function checkUpdates() {
  const currentVersion = "2";
  fetch("/api/check-updates")
      .then(response => response.json())
      .then(data => {
        if (data.updateAvailable) {
          document.getElementById("output").innerHTML =
              `An Update is available: Updated build: ${data.latestVersion} Your build: ${currentVersion} Node9 VPN might not work until you update <a href="#" id="updateLink">Here</a>`;
  
          document.getElementById("updateLink").addEventListener("click", (event) => {
              event.preventDefault();
              openBrowser("https://vpn.node9.dev/download/"); 
          });
      } else {
          document.getElementById("output").innerHTML = "You are on the latest version.";
      }
      })
      .catch(err => {
          document.getElementById("output").textContent =
              "Error checking updates.";
      });
}


/********************************************
 * Save Credentials
 ********************************************/
function saveCredentials(username, password) {
  fetch("/api/save-credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).catch((err) => {
    console.error("Error saving credentials:", err);
  });
}

/********************************************
 * Sign Out
 ********************************************/
function signOut() {
  // Clears credentials.json on the server, shows login page
  fetch("/api/sign-out", { method: "POST" })
    .then((response) => {
      if (!response.ok) {
        throw new Error("Failed to sign out.");
      }
      return response.json();
    })
    .then(() => {
      document.getElementById("login-page").classList.remove("hidden");
    })
    .catch((err) => {
      console.error("Sign out error:", err);
    });
}

function Streamcfg() {
  const servers = [
      { name: "AU-SYD-1", url: "https://vpn.node9.dev/configs/AU-SYD-1-V4.ovpn" },
  ];

  if (!window.electronAPI || !window.electronAPI.downloadConfigFiles) {
      console.error("Electron API not loaded!");
      return;
  }

  window.electronAPI.downloadConfigFiles(servers).then((result) => {
      if (result.success) {
          console.log("Configs downloaded successfully!");
          populateServerDropdown();
      } else {
          console.error("Failed to download configs:", result.error);
      }
  });
}

/********************************************
 * Window onLoad
 ********************************************/
window.onload = function () {
  updateUIState();
  Streamcfg();
  checkCredentials();
  checkUpdates();

  if (Notification.permission === "default") {
    Notification.requestPermission().then((permission) => {
      if (permission !== "granted") {
        console.error("Notifications are not enabled.");
      }
    });
  }
};

/********************************************
 * IPC from Electron (main.js)
 ********************************************/
window.electron.receive("errorMessage", (error) => {
  if (Notification.permission === "granted") {
    new Notification("VPN Error", { body: error });
  }
  console.error("Received error message:", error);
});

window.electron.receive("connectionStatus", (status) => {
  console.log("Connection status received:", status);

  const statusText = document.getElementById("status-text");
  const powerCircle = document.getElementById("power-circle");

  if (status.state === "Error") {
    stopConnectedTimeTimer();
    statusText.textContent = "Error";
    statusText.style.color = "#f44336";
    statusText.style.backgroundColor = "rgba(244,67,54,0.1)";
    powerCircle.classList.remove("connecting", "connected");
    isConnected = false;
  } else if (status.state === "Connecting") {
    stopConnectedTimeTimer();
    statusText.textContent = "Connecting...";
    statusText.style.color = "#f5c957";
    statusText.style.backgroundColor = "rgba(245,201,87,0.1)";
    powerCircle.classList.add("connecting");
    isConnected = false;
  } else if (status.state === "Connected") {
    startConnectedTimeTimer();
    statusText.textContent = "Connected";
    statusText.style.color = "#4caf50";
    statusText.style.backgroundColor = "rgba(76,175,80,0.1)";
    powerCircle.classList.remove("connecting");
    powerCircle.classList.add("connected");
    isConnected = true;
  } else {
    // Disconnected or unknown
    stopConnectedTimeTimer();
    statusText.textContent = "Disconnected";
    statusText.style.color = "#bbb";
    statusText.style.backgroundColor = "rgba(255,255,255,0.05)";
    powerCircle.classList.remove("connecting", "connected");
    isConnected = false;
  }

  updateUIState();
});
