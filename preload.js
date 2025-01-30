const { contextBridge, ipcRenderer } = require("electron");

// Expose IPC methods to the renderer process
contextBridge.exposeInMainWorld("electron", {
    receive: (channel, func) => {
        const validChannels = ["connectionStatus"];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    },
    // invoke: (channel, data) => {
    //     const validChannels = ["from-server"];
    //     if (validChannels.includes(channel)) {
    //         return ipcRenderer.invoke(channel, data);
    //     }
    // }
});


contextBridge.exposeInMainWorld("electronAPI", {
    downloadConfigFiles: (servers) => ipcRenderer.invoke("download-configs", servers)
});
