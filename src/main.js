const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('minecraft-launcher-core');
const msmc = require('msmc');
const fs = require('fs-extra');
const axios = require('axios');
const Store = require('electron-store');
const AdmZip = require('adm-zip');

const store = new Store();
let win;

const FABRIC_META = 'https://meta.fabricmc.net/v2';

const CONTENT_TYPES = {
    mods: 'mods',
    resourcepacks: 'resourcepacks',
    shaderpacks: 'shaderpacks'
};

const defaultInstanceConfig = (name) => ({
    name,
    version: '1.21.1',
    loaderType: 'fabric',
    loaderVersion: '',
    fabric: true,
    memoryMin: '2G',
    memoryMax: '4G',
    jvmArgs: '',
    preLaunchCommand: '',
    postExitCommand: '',
    wrapperCommand: '',
    showConsoleOnLaunch: false,
    showConsoleOnCrash: true,
    closeLauncherOnLaunch: false,
    envVars: {}
});

const parseJvmArgs = (args) => {
    if (!args || !args.trim()) return [];
    const matches = args.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    return matches.map((token) => token.replace(/^"|"$/g, ''));
};

const sanitizeName = (name) => name.replace(/\s/g, '_');

const uniqueInstanceName = async (baseName) => {
    const clean = sanitizeName(baseName || 'modpack_instance');
    let candidate = clean;
    let suffix = 2;

    while (await fs.pathExists(path.join(mcPath, 'instances', candidate))) {
        candidate = `${clean}_${suffix}`;
        suffix += 1;
    }

    return candidate;
};

const resolveLoaderFromDependencies = (dependencies = {}) => {
    if (dependencies['fabric-loader']) {
        return { loaderType: 'fabric', loaderVersion: String(dependencies['fabric-loader']) };
    }

    if (dependencies['quilt-loader']) {
        return { loaderType: 'quilt', loaderVersion: String(dependencies['quilt-loader']) };
    }

    if (dependencies['forge']) {
        return { loaderType: 'forge', loaderVersion: String(dependencies['forge']) };
    }

    if (dependencies['neoforge']) {
        return { loaderType: 'neoforge', loaderVersion: String(dependencies['neoforge']) };
    }

    return { loaderType: 'vanilla', loaderVersion: '' };
};

const getAppPath = () => {
    switch (process.platform) {
        case 'win32': return path.join(process.env.APPDATA, 'kebablauncher');
        case 'darwin': return path.join(app.getPath('home'), 'Library', 'Application Support', 'kebablauncher');
        default: return path.join(app.getPath('home'), '.kebablauncher');
    }
};

const mcPath = getAppPath();
fs.ensureDirSync(path.join(mcPath, 'instances'));

// MCLC treats `root` as the .minecraft directory; keep instance root aligned with that.
const toMcDir = (instancePath) => instancePath;

const migrateLegacyDotMinecraft = async (instancePath) => {
    const legacyMcDir = path.join(instancePath, '.minecraft');
    if (!(await fs.pathExists(legacyMcDir))) return;

    const entries = await fs.readdir(legacyMcDir);
    for (const entry of entries) {
        const fromPath = path.join(legacyMcDir, entry);
        const toPath = path.join(instancePath, entry);

        if (await fs.pathExists(toPath)) {
            await fs.copy(fromPath, toPath, { overwrite: true, errorOnExist: false });
            await fs.remove(fromPath);
            continue;
        }

        await fs.move(fromPath, toPath, { overwrite: true });
    }

    await fs.remove(legacyMcDir);
};

const ensureInstanceFolders = async (instancePath) => {
    const mcDir = toMcDir(instancePath);
    await Promise.all([
        fs.ensureDir(path.join(mcDir, 'mods')),
        fs.ensureDir(path.join(mcDir, 'resourcepacks')),
        fs.ensureDir(path.join(mcDir, 'shaderpacks')),
        fs.ensureDir(path.join(mcDir, 'versions'))
    ]);
};

const getAccounts = () => store.get('accounts', []);
const setAccounts = (accounts) => store.set('accounts', accounts);
const getActiveAccountUuid = () => store.get('activeAccountUuid', null);
const setActiveAccountUuid = (uuid) => store.set('activeAccountUuid', uuid || null);

const resolveActiveAccount = (accounts) => {
    if (!accounts.length) return null;
    const activeUuid = getActiveAccountUuid();
    const active = activeUuid ? accounts.find((entry) => entry.uuid === activeUuid) : null;
    if (active) return active;
    setActiveAccountUuid(accounts[0].uuid);
    return accounts[0];
};

const loadInstanceConfig = async (instancePath) => {
    const folder = path.basename(instancePath);
    const configPath = path.join(instancePath, 'instance.json');
    let config = defaultInstanceConfig(folder);

    if (await fs.pathExists(configPath)) {
        const loaded = await fs.readJson(configPath);
        config = { ...config, ...loaded };
    }

    const iconPath = config.icon
        ? path.join(instancePath, config.icon)
        : path.join(instancePath, 'icon.png');

    const iconAbsolutePath = (await fs.pathExists(iconPath)) ? iconPath : null;
    return { ...config, path: instancePath, iconAbsolutePath };
};

const saveInstanceConfig = async (instancePath, config) => {
    await fs.ensureDir(instancePath);
    await ensureInstanceFolders(instancePath);
    await fs.writeJson(path.join(instancePath, 'instance.json'), config, { spaces: 2 });
};

const resolveContentDir = (instancePath, type) => {
    const mapped = CONTENT_TYPES[type];
    if (!mapped) throw new Error(`Unsupported content type: ${type}`);
    return path.join(toMcDir(instancePath), mapped);
};

const listContentFiles = async (instancePath, type) => {
    const dir = resolveContentDir(instancePath, type);
    await fs.ensureDir(dir);

    const entries = await fs.readdir(dir);
    const files = [];

    for (const name of entries) {
        const full = path.join(dir, name);
        const stat = await fs.stat(full);
        if (!stat.isFile()) continue;
        files.push({
            name,
            size: stat.size,
            modifiedAt: stat.mtimeMs
        });
    }

    files.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return files;
};

const runShellCommand = (command, env = {}, onData = () => {}) => {
    if (!command || !command.trim()) return Promise.resolve(0);

    return new Promise((resolve, reject) => {
        const child = spawn(command, {
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env }
        });

        child.stdout.on('data', (chunk) => {
            const line = String(chunk).trimEnd();
            if (line) onData(line);
        });

        child.stderr.on('data', (chunk) => {
            const line = String(chunk).trimEnd();
            if (line) onData(line);
        });

        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 0));
    });
};

const getLatestFabricLoader = async (mcVersion) => {
    const { data } = await axios.get(`${FABRIC_META}/versions/loader/${mcVersion}`);
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No Fabric loader available for ${mcVersion}`);
    }

    const stable = data.find((entry) => entry?.loader?.stable) || data[0];
    return stable.loader.version;
};

const getLatestFabricInstaller = async () => {
    const { data } = await axios.get(`${FABRIC_META}/versions/installer`);
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('No Fabric installer version found');
    }

    const stable = data.find((entry) => entry?.stable) || data[0];
    return stable.version;
};

const ensureFabricProfile = async (instancePath, mcVersion) => {
    const loaderVersion = await getLatestFabricLoader(mcVersion);
    const installerVersion = await getLatestFabricInstaller();

    const primaryUrl = `${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/${installerVersion}/profile/json`;
    const fallbackUrl = `${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;

    let profile;
    try {
        const { data } = await axios.get(primaryUrl);
        profile = data;
    } catch {
        const { data } = await axios.get(fallbackUrl);
        profile = data;
    }

    if (!profile?.id) {
        throw new Error('Fabric profile response did not include an id');
    }

    const versionDir = path.join(toMcDir(instancePath), 'versions', profile.id);
    await fs.ensureDir(versionDir);
    await fs.writeJson(path.join(versionDir, `${profile.id}.json`), profile, { spaces: 2 });
    return profile.id;
};

const importMrpack = async ({ mrpackPath, instancePath, fallbackName }) => {
    const zip = new AdmZip(mrpackPath);
    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) throw new Error('Invalid .mrpack: modrinth.index.json not found');

    const index = JSON.parse(zip.readAsText(indexEntry));
    const dependencies = index.dependencies || {};

    const mcVersion = dependencies.minecraft || '1.21.1';
    const { loaderType, loaderVersion } = resolveLoaderFromDependencies(dependencies);
    const fabric = loaderType === 'fabric';

    await ensureInstanceFolders(instancePath);
    const mcDir = toMcDir(instancePath);

    for (const prefix of ['overrides/', 'client-overrides/']) {
        const entries = zip.getEntries().filter((entry) => entry.entryName.startsWith(prefix) && !entry.isDirectory);
        for (const entry of entries) {
            const relative = entry.entryName.slice(prefix.length);
            if (!relative) continue;
            const outPath = path.join(mcDir, relative);
            await fs.ensureDir(path.dirname(outPath));
            await fs.writeFile(outPath, entry.getData());
        }
    }

    const files = Array.isArray(index.files) ? index.files : [];
    for (const file of files) {
        if (file?.env?.client === 'unsupported') continue;
        const url = Array.isArray(file.downloads) ? file.downloads[0] : null;
        if (!url || !file.path) continue;

        const outPath = path.join(mcDir, file.path);
        await fs.ensureDir(path.dirname(outPath));
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        await fs.writeFile(outPath, Buffer.from(response.data));
    }

    const defaultName = sanitizeName(index.name || path.basename(mrpackPath, path.extname(mrpackPath)));
    const finalName = fallbackName || defaultName;

    const config = {
        ...defaultInstanceConfig(finalName),
        name: finalName,
        version: mcVersion,
        loaderType,
        loaderVersion,
        fabric
    };

    await saveInstanceConfig(instancePath, config);
    return config;
};

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 860,
        title: 'Kebab Launcher',
        backgroundColor: '#0b0f21',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

ipcMain.handle('get-data', async () => {
    const instancesDir = path.join(mcPath, 'instances');
    await fs.ensureDir(instancesDir);

    const entries = await fs.readdir(instancesDir);
    const instances = [];

    for (const entry of entries) {
        const full = path.join(instancesDir, entry);
        if (!(await fs.lstat(full)).isDirectory()) continue;
        instances.push(await loadInstanceConfig(full));
    }

    const accounts = getAccounts();
    const active = resolveActiveAccount(accounts);

    return {
        path: mcPath,
        accounts,
        activeAccountUuid: active?.uuid || null,
        msToken: active || null,
        instances
    };
});

ipcMain.handle('save-instance', async (e, { instancePath, config, oldPath }) => {
    if (oldPath && oldPath !== instancePath) {
        await fs.move(oldPath, instancePath, { overwrite: true });
    }

    const merged = {
        ...defaultInstanceConfig(config.name || path.basename(instancePath)),
        ...config
    };

    if (!merged.loaderType) {
        merged.loaderType = merged.fabric ? 'fabric' : 'vanilla';
    }

    await saveInstanceConfig(instancePath, merged);
    return await loadInstanceConfig(instancePath);
});

ipcMain.handle('pick-modpack-file', async () => {
    const result = await dialog.showOpenDialog(win, {
        title: 'Choose Modpack',
        properties: ['openFile'],
        filters: [
            { name: 'Modpack', extensions: ['mrpack'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
});

ipcMain.handle('create-instance-from-modpack', async (e, { name, modpackPath }) => {
    if (!modpackPath) throw new Error('No modpack selected');
    if (path.extname(modpackPath).toLowerCase() !== '.mrpack') {
        throw new Error('Only .mrpack files are supported at the moment');
    }

    const preferredName = sanitizeName(name || path.basename(modpackPath, path.extname(modpackPath)));
    const instanceName = await uniqueInstanceName(preferredName);
    const instancePath = path.join(mcPath, 'instances', instanceName);

    const config = await importMrpack({ mrpackPath: modpackPath, instancePath, fallbackName: instanceName });
    return { ...config, path: instancePath };
});

ipcMain.handle('set-instance-icon', async (e, { instancePath }) => {
    const result = await dialog.showOpenDialog(win, {
        title: 'Choose Instance Icon',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });

    if (result.canceled || !result.filePaths[0]) return null;

    const selectedPath = result.filePaths[0];
    const ext = path.extname(selectedPath).toLowerCase() || '.png';
    const fileName = `icon${ext}`;
    const destPath = path.join(instancePath, fileName);

    await fs.ensureDir(instancePath);
    await fs.copyFile(selectedPath, destPath);

    const configPath = path.join(instancePath, 'instance.json');
    const current = (await fs.pathExists(configPath))
        ? await fs.readJson(configPath)
        : defaultInstanceConfig(path.basename(instancePath));

    current.icon = fileName;
    await fs.writeJson(configPath, current, { spaces: 2 });
    return destPath;
});

ipcMain.handle('instance:list-content', async (e, { instancePath, type }) => {
    return await listContentFiles(instancePath, type);
});

ipcMain.handle('instance:import-content', async (e, { instancePath, type }) => {
    const filterMap = {
        mods: [{ name: 'Mods', extensions: ['jar', 'zip'] }],
        resourcepacks: [{ name: 'Resource Packs', extensions: ['zip', 'jar'] }],
        shaderpacks: [{ name: 'Shader Packs', extensions: ['zip'] }]
    };

    const result = await dialog.showOpenDialog(win, {
        title: `Import ${type}`,
        properties: ['openFile', 'multiSelections'],
        filters: filterMap[type] || [{ name: 'All Files', extensions: ['*'] }]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const targetDir = resolveContentDir(instancePath, type);
        await fs.ensureDir(targetDir);

        for (const source of result.filePaths) {
            const target = path.join(targetDir, path.basename(source));
            await fs.copy(source, target, { overwrite: true });
        }
    }

    return await listContentFiles(instancePath, type);
});

ipcMain.handle('instance:remove-content', async (e, { instancePath, type, fileName }) => {
    const targetDir = resolveContentDir(instancePath, type);
    const targetFile = path.join(targetDir, fileName);
    await fs.remove(targetFile);
    return await listContentFiles(instancePath, type);
});

ipcMain.handle('instance:open-content-folder', async (e, { instancePath, type }) => {
    const targetDir = resolveContentDir(instancePath, type);
    await fs.ensureDir(targetDir);
    return shell.openPath(targetDir);
});

ipcMain.handle('ms-login', async () => {
    const authManager = new msmc.Auth('select_account');
    const xboxManager = await authManager.launch('raw');
    const token = (await xboxManager.getMinecraft()).mclc();

    const current = getAccounts();
    const next = current.filter((entry) => entry.uuid !== token.uuid);
    next.push(token);

    setAccounts(next);
    setActiveAccountUuid(token.uuid);

    return token;
});

ipcMain.handle('set-active-account', async (e, uuid) => {
    const accounts = getAccounts();
    const exists = accounts.some((entry) => entry.uuid === uuid);
    if (!exists) return null;
    setActiveAccountUuid(uuid);
    return uuid;
});

ipcMain.handle('remove-account', async (e, uuid) => {
    const current = getAccounts();
    const next = current.filter((entry) => entry.uuid !== uuid);
    setAccounts(next);

    if (getActiveAccountUuid() === uuid) {
        setActiveAccountUuid(next[0]?.uuid || null);
    }

    return next;
});

ipcMain.on('launch-game', async (event, { instance, auth }) => {
    const {
        path: instancePath,
        version,
        fabric,
        loaderType = fabric ? 'fabric' : 'vanilla',
        memoryMin = '2G',
        memoryMax = '4G',
        jvmArgs = '',
        preLaunchCommand = '',
        postExitCommand = '',
        envVars = {}
    } = instance;

    const activeAuth = auth || resolveActiveAccount(getAccounts());
    if (!activeAuth) {
        event.reply('log', '[launcher] No active account selected.');
        event.reply('game-closed');
        return;
    }

    // Backward compatibility for instances created before root-path fix.
    await migrateLegacyDotMinecraft(instancePath);

    let launchVersion = { number: version, type: 'release' };

    if (loaderType !== 'vanilla' && loaderType !== 'fabric') {
        event.reply('log', `[launcher] Imported loader '${loaderType}' is not supported yet in this build.`);
        event.reply('game-closed');
        return;
    }

    if (fabric || loaderType === 'fabric') {
        try {
            const fabricVersionId = await ensureFabricProfile(instancePath, version);
            launchVersion = { ...launchVersion, custom: fabricVersionId };
            event.reply('log', `[launcher] Using Fabric profile ${fabricVersionId}`);
        } catch (err) {
            event.reply('log', `[launcher] Fabric setup failed: ${err.message || err}`);
            event.reply('game-closed');
            return;
        }
    }

    const commandEnv = {
        INST_NAME: instance.name,
        INST_ID: path.basename(instancePath),
        INST_DIR: instancePath,
        INST_MC_DIR: toMcDir(instancePath),
        ...envVars
    };

    try {
        const preCode = await runShellCommand(preLaunchCommand, commandEnv, (line) => {
            event.reply('log', `[prelaunch] ${line}`);
        });

        if (preCode !== 0) {
            event.reply('log', `[launcher] Pre-launch command exited with ${preCode}`);
            event.reply('game-closed');
            return;
        }
    } catch (err) {
        event.reply('log', `[launcher] Pre-launch command failed: ${err.message || err}`);
        event.reply('game-closed');
        return;
    }

    const launcher = new Client();
    const opts = {
        authorization: activeAuth,
        root: instancePath,
        version: launchVersion,
        memory: { max: memoryMax, min: memoryMin }
    };

    const extraArgs = parseJvmArgs(jvmArgs);
    if (extraArgs.length) opts.javaArgs = extraArgs;

    launcher.on('progress', (progress) => event.reply('progress', progress));
    launcher.on('data', (line) => event.reply('log', line));
    launcher.on('close', async () => {
        event.reply('game-closed');

        try {
            const postCode = await runShellCommand(postExitCommand, commandEnv, (line) => {
                event.reply('log', `[postexit] ${line}`);
            });

            if (postCode !== 0) {
                event.reply('log', `[launcher] Post-exit command exited with ${postCode}`);
            }
        } catch (err) {
            event.reply('log', `[launcher] Post-exit command failed: ${err.message || err}`);
        }
    });

    try {
        await launcher.launch(opts);
    } catch (err) {
        event.reply('log', `[launcher] Launch failed: ${err.message || err}`);
        event.reply('game-closed');
    }
});

ipcMain.handle('delete-instance', async (e, instancePath) => await fs.remove(instancePath));
ipcMain.handle('open-folder', (e, folderPath) => shell.openPath(folderPath));
