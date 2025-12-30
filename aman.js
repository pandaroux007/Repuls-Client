const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const shortcut = require('electron-localshortcut');
const RPC = require('discord-rpc');
const axios = require('axios');
const { updateElectronApp } = require('update-electron-app');

let playFabData = {
    sessionTicket: null,
    playFabId: null,
    fullAccountInfo: "No data captured yet. Open the game to login dum dum"
};

updateElectronApp();

let win;
let rpc;
const GAME_URL = 'https://repuls.io';
const RPC_CLIENT_ID = '1429162289206001677';

const sessionStartTime = Date.now();

const REGION_APIS = {
    as01: "https://rep.as01.docskigames.com/serverList?version",
    eu01: "https://rep.eu01.docskigames.com/serverList?version",
    na01: "https://rep.na01.docskigames.com/serverList?version",
};

let currentGameState = "Home";
let currentServerInfo = { region: null, port: null, map: null, mode: null, players: 0, maxPlayers: 0 };
let showJoinButton = true;

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-vulkan'); 
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,CanvasOopRasterization,UseSkiaRenderer,WebGPU');
app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-print-preview');
app.commandLine.appendSwitch('disable-metrics');
app.commandLine.appendSwitch('disable-metrics-repo');
app.commandLine.appendSwitch('smooth-scrolling');
app.commandLine.appendSwitch('enable-javascript-harmony');
app.commandLine.appendSwitch('enable-future-v8-vm-features');
app.commandLine.appendSwitch('disable-hang-monitor');
app.commandLine.appendSwitch('no-referrers');
app.commandLine.appendSwitch('disable-2d-canvas-clip-aa');
app.commandLine.appendSwitch('disable-bundled-ppapi-flash');
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage=100');
app.commandLine.appendSwitch('enable-pointer-lock-options');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-quic');
app.commandLine.appendSwitch('high-dpi-support','1');
app.commandLine.appendSwitch('js-flags', '--expose-gc');

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (url.includes('docskigames.com') || url.includes('repuls.io')) {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});

function updateRPC() {
    if (!rpc) return;

    let details = 'A Docski Game';
    let state = 'Main Menu';
    let buttons = [{ label: 'View Client', url: 'https://github.com/AmanLovesCats/Repuls-Client' }];
    let party = undefined;
    let secrets = undefined;

    if (currentGameState === "Store") {
        details = "Browsing the Store";
        state = "Customizing Character and guns";
    } else if (currentGameState === "Playing" && currentServerInfo.region && currentServerInfo.port) {
        details = `${currentServerInfo.mode || 'Combat'} on ${currentServerInfo.map || 'Repuls'}`;
        state = `Match: ${currentServerInfo.players}/${currentServerInfo.maxPlayers} players`;
        
        const joinLink = `https://repuls.io/?r=${currentServerInfo.region}&game=${currentServerInfo.port}`;

        if (showJoinButton) {
            buttons.unshift({ label: 'Join My Match', url: joinLink });
            party = {
                id: `repuls-${currentServerInfo.region}-${currentServerInfo.port}`,
                size: [parseInt(currentServerInfo.players) || 1, parseInt(currentServerInfo.maxPlayers) || 12]
            };
            
            secrets = {
                join: joinLink
            };
        }
    }

    rpc.setActivity({
        details: details,
        state: state,
        startTimestamp: sessionStartTime,
        largeImageKey: 'b5ffbbc93f102bde5c6af1b5b6175853',
        largeImageText: 'Repuls.io Client',
        buttons: buttons.slice(0, 2),
        party: party,
        secrets: secrets,
        instance: true,
    }).catch(err => console.error('RPC Update Error:', err));
}

async function refreshServerData() {
    if (currentGameState !== "Playing" || !currentServerInfo.region) return;
    try {
        const apiUrl = REGION_APIS[currentServerInfo.region];
        const response = await axios.get(apiUrl);
        const servers = response.data.serverList;
        const match = servers.find(s => s.webPort === currentServerInfo.port.toString());
        if (match) {
            currentServerInfo.map = match.gameMap;
            currentServerInfo.mode = match.gameMode;
            currentServerInfo.players = match.playerCount;
            currentServerInfo.maxPlayers = match.maxPlayers;
            updateRPC();
        }
    } catch (err) { console.error('[API Error]', err.message); }
}

function setupDiscordRPC() {
    rpc = new RPC.Client({ transport: 'ipc' });
    rpc.on('ready', () => { 
        updateRPC(); 
        setInterval(() => {
            if (currentGameState === "Playing" && currentServerInfo.region) {
                refreshServerData();
            }
        }, 30000);
    });
    rpc.login({ clientId: RPC_CLIENT_ID }).catch(console.error);
}

function setupDebugger(window) {
    try {
        window.webContents.debugger.attach('1.3');
    } catch (err) {
        console.error('Debugger attach failed: ', err);
    }

    window.webContents.debugger.on('message', async (event, method, params) => {
        if (method === 'Network.responseReceived') {
            const { url } = params.response;
            if (url.includes('Client/LoginWithCustomID')) {
                const requestId = params.requestId;
                try {
                    const result = await window.webContents.debugger.sendCommand('Network.getResponseBody', { requestId });
                    const body = JSON.parse(result.body);
                    if (body.data && body.data.PlayFabId) {
                        playFabData.playFabId = body.data.PlayFabId;
                        playFabData.sessionTicket = body.data.SessionTicket;
                        fetchFullAccountInfo();
                    }
                } catch (e) { console.error('Failed to get login body'); }
            }
        }
    });
    window.webContents.debugger.sendCommand('Network.enable');
}

async function fetchFullAccountInfo() {
    if (!playFabData.playFabId || !playFabData.sessionTicket) return;

    try {
        const response = await axios.post(
            `https://df3ef.playfabapi.com/Client/GetPlayerCombinedInfo?sdk=UnitySDK-2.170.230707`,
            {
                PlayFabId: playFabData.playFabId,
                InfoRequestParameters: {
                    GetUserAccountInfo: true,
                    GetUserReadOnlyData: true,
                    GetPlayerStatistics: true
                }
            },
            { headers: { 'X-Authorization': playFabData.sessionTicket } }
        );

        const payload = response.data.data.InfoResultPayload;
        const account = payload.AccountInfo;
        
        let stats = {};
        if (payload.UserReadOnlyData && payload.UserReadOnlyData.Properties) {
            try {
                stats = JSON.parse(payload.UserReadOnlyData.Properties.Value);
            } catch (e) {
                console.error("Failed to parse nested Properties JSON");
            }
        }

        const getVal = (key, fallback = "0") => stats[key] !== undefined ? stats[key] : fallback;

        const createdDate = new Date(account.Created);
        const discordTimestamp = `<t:${Math.floor(createdDate.getTime() / 1000)}:D>`;

        let weaponList = "No weapon data found.";
        if (stats.killStats && Array.isArray(stats.killStats)) {
            weaponList = stats.killStats
                .sort((a, b) => b.count - a.count)
                .slice(0, 5)
                .map((w, i) => `${i + 1}. **${w.Id}**: ${w.count}`)
                .join("\n");
        }

        const getAchieve = (id) => {
            const item = (stats.achievementProgressions || []).find(a => a.Id === id);
            return item ? item.count : "0";
        };

        const output = [
            `👤 **Player:** ${account.TitleInfo.DisplayName || account.Username}`,
            `📅 **Joined:** ${discordTimestamp}`,   
            `---`,
            `⭐ **Level:** ${getVal('Level')}  |  **Kills:** ${getVal('stat_kills')}  |  **Deaths:** ${getVal('stat_deaths')}`,
            `🎮 **Matches:** ${getVal('stat_matches')} (Won: ${getVal('stat_wins')})`,
            `🎯 **Headshots:** ${getAchieve('headshot')}  |  **Flags:** ${getVal('stat_flags')}`,
            `🔥 **Streaks:** Win Streak: ${getAchieve('winstreak')}`,
            `---`,
            `⚔️ **Top 5 Weapons (Kills):**`,
            weaponList,
            `---`,
            `*Generated by Aman's Repuls Client*`
        ].join("\n");

        playFabData.fullAccountInfo = output;
    } catch (err) {
        console.error('Fetch Error:', err);
        playFabData.fullAccountInfo = "Error: Could not parse account data.";
    }
}

function createWindow() {
    win = new BrowserWindow({
        width: 1920, height: 1080,
        fullscreen: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
        }
    });

    setupDebugger(win);

    win.loadURL(GAME_URL);
    win.removeMenu();

    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        if (message) {
            if (message.includes('[store]page:')) {
                currentGameState = "Store";
                updateRPC();
            } 
            else if (message.includes('[preview] refresh')) {
                currentGameState = "Home";
                updateRPC();
            }
            else if (message.includes('[gamestate]')) {
                currentGameState = message.includes('Playing') ? 'Playing' : 'Home';
                updateRPC();
            }

            if (message.includes('Connected to wss://')) {
                const regionMatch = message.match(/rep\.(\w+)\.docski/);
                const portMatch = message.match(/port=(\d+)/);
                if (regionMatch && portMatch) {
                    currentServerInfo.region = regionMatch[1];
                    currentServerInfo.port = portMatch[1];
                    refreshServerData();
                }
            }
        }
    });

    const isGoogleAuth = (url) => {
        return url.includes('accounts.google.com') || 
               url.includes('googleusercontent.com') ||
               url.includes('apis.google.com');
    };

    win.webContents.on('will-navigate', (event, navigationUrl) => {
        if (navigationUrl.startsWith(GAME_URL) || isGoogleAuth(navigationUrl)) return; 
        event.preventDefault();
        shell.openExternal(navigationUrl);
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isGoogleAuth(url)) return { action: 'allow' };
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

function buildDiscordInviteText() {
    if (currentGameState !== "Playing" || !currentServerInfo.region || !currentServerInfo.port) {
        return "Not currently in a match.";
    }
    const joinUrl = `https://repuls.io/?r=${currentServerInfo.region}&game=${currentServerInfo.port}`;
    return [
        "🎮 **Repuls.io Match Invite**",
        `🗺️ **Map:** ${currentServerInfo.map || "Unknown"}`,
        `⚔️ **Mode:** ${currentServerInfo.mode || "Unknown"}`,
        `👥 **Players:** ${currentServerInfo.players || "?"} / ${currentServerInfo.maxPlayers || "?"}`,
        `🌍 **Region:** ${currentServerInfo.region.toUpperCase()}`,
        "",
        `🔗 **Join Match:** ${joinUrl}`
    ].join("\n");
}


function registerShortcuts() {
    shortcut.register(win, 'F1', () => win.loadURL(GAME_URL));
    
    shortcut.register(win, 'F9', async () => {
        if (currentGameState === "Playing") await refreshServerData();
        clipboard.writeText(buildDiscordInviteText());
        dialog.showMessageBox(win, { type: 'info', title: 'Invite Copied', message: 'Invite text copied!', buttons: ['OK'] });
    });

    shortcut.register(win, 'F11', () => win.setSimpleFullScreen(!win.isSimpleFullScreen()));
    
    shortcut.register(win, 'F6', () => {
        showJoinButton = !showJoinButton;
        updateRPC();
        dialog.showMessageBox(win, { type: 'info', title: 'RPC Toggle', message: `Join button ${showJoinButton ? 'ENABLED' : 'DISABLED'}.`, buttons: ['OK'] });
    });

    shortcut.register(win, 'Ctrl+F1', () => {
        win.webContents.session.clearStorageData({ storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'] });
        dialog.showMessageBox(win, { type: 'info', title: 'Storage Cleared', message: 'Data cleared. Reload with F1.', buttons: ['OK'] });
    });

    shortcut.register(win, 'F12', async () => {
        await fetchFullAccountInfo();
        
        let output = playFabData.fullAccountInfo;
        if (output.length > 1990) output = output.substring(0, 1987) + "...";

        clipboard.writeText(output);
        dialog.showMessageBox(win, { type: 'info', title: 'Data Copied', message: 'Formatted player stats copied to clipboard.', buttons: ['OK'] });
    });

    shortcut.register(win, 'Ctrl+F5', () => { 
        app.relaunch(); 
        app.quit(); 
    });
}

app.on('ready', () => {
    createWindow();
    registerShortcuts();
    setupDiscordRPC();
});