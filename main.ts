import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import axios from 'axios';

// Conditional imports for desktop-only functionality
let spawn: any, exec: any, readFileSync: any, writeFileSync: any;

try {
	// These will only work on desktop platforms
	const childProcess = require("child_process");
	const fs = require('fs');
	spawn = childProcess.spawn;
	exec = childProcess.exec;
	readFileSync = fs.readFileSync;
	writeFileSync = fs.writeFileSync;
} catch (error) {
	// Mobile platform - these modules are not available
	console.log('Desktop-only modules not available (mobile platform detected)');
}

interface Settings {
	syncthingApiKey: string;
	vaultFolderID: string;
	startOnObsidianOpen: boolean;
	stopOnObsidianClose: boolean;
	useDocker: boolean;
	remoteUrl: string;
	mobileMode: boolean;
}

const DEFAULT_SETTINGS: Settings = {
	syncthingApiKey: '',
	vaultFolderID: '',
	startOnObsidianOpen: false,
	stopOnObsidianClose: false,
	useDocker: false,
	remoteUrl: 'http://127.0.0.1:8384',
	mobileMode: false,
}

const UPDATE_INTERVAL = 5000;
const SYNCTHING_CONTAINER_URL = "http://127.0.0.1:8384/";
const SYNCTHING_CORS_PROXY_CONTAINER_URL = "http://127.0.0.1:8380/";

export default class SyncthingLauncher extends Plugin {
	public settings: Settings;

	private vaultPath = "";
	private vaultName = "";
	private isMobile = false;

	private syncthingInstance: any | null = null;
	private syncthingLastSyncDate: string = "no data";

	private statusBarConnectionIconItem: HTMLElement | null = this.addStatusBarItem();
	private statusBarLastSyncTextItem: HTMLElement | null = this.addStatusBarItem();

	async onload() {
		await this.loadSettings();

		// Detect mobile platform
		this.isMobile = this.detectMobilePlatform();
		
		// Auto-enable mobile mode on mobile platforms
		if (this.isMobile && !this.settings.mobileMode) {
			this.settings.mobileMode = true;
			await this.saveSettings();
		}

		let adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			this.vaultPath = adapter.getBasePath();
			this.vaultName = adapter.getName();
		}

		this.statusBarConnectionIconItem?.addClasses(['status-bar-item', 'status-icon']);
		this.statusBarConnectionIconItem?.setAttribute('data-tooltip-position', 'top');

		this.statusBarConnectionIconItem?.onClickEvent((event) => {
			this.isSyncthingRunning().then(isRunning => {
				if (!isRunning) {
					new Notice('Starting Syncthing!');
					this.startSyncthing();
				}
				else {
					new Notice('Stopping Syncthing!');
					this.stopSyncthing();
				}
			}
		)});

		// Update syncthing the status bar item
		this.updateStatusBar();

		// Register tick interval
		this.registerInterval(
			window.setInterval(() => this.updateStatusBar(), UPDATE_INTERVAL)
		);

		// Register settings tab
		this.addSettingTab(new SettingTab(this.app, this));

		// Start syncthing if set in settings
		if (this.settings.startOnObsidianOpen)
		{
			this.startSyncthing();
		}

		// Register on Obsidian close handler 
		window.addEventListener('beforeunload', this.handleBeforeUnload.bind(this));
	}

	onunload() {
		window.removeEventListener('beforeunload', this.handleBeforeUnload.bind(this));
	}

	// --- Logic ---

	handleBeforeUnload(event: any) {
		// Kill syncthing if running and set in settings
		if (this.settings.stopOnObsidianClose)
		{
			this.stopSyncthing();
		}
	}

	async startSyncthing() {
		this.isSyncthingRunning().then(async isRunning => {
			// Check if already running
			if (isRunning) {
				console.log('Syncthing is already running');
				return;
			}

			// Mobile mode - cannot start Syncthing locally
			if (this.isMobile || this.settings.mobileMode) {
				new Notice('Mobile mode: Please connect to an existing Syncthing instance via Remote URL in settings', 5000);
				return;
			}

			if (this.settings.useDocker) // Docker
			{
				if (this.checkDockerStatus())
				{
					new Notice('Starting Docker');
					this.startSyncthingDockerStack();
				}
			}
			else // Local Obsidian sub-process
			{
				if (!spawn) {
					new Notice('Local Syncthing execution not available on mobile platforms', 5000);
					return;
				}

				// Check if executable exists
				const executableExists = await this.checkExecutableExists();
				if (!executableExists) {
					new Notice('Syncthing executable missing. Attempting to download...', 5000);
					const downloadSuccess = await this.downloadSyncthingExecutable();
					if (!downloadSuccess) {
						new Notice('Auto-download failed. Please manually download syncthing-executables.tar.gz from the GitHub release or enable Mobile Mode.', 15000);
						return;
					}
				}

				const executablePath = this.getSyncthingExecutablePath();
				this.syncthingInstance = spawn(executablePath, []);

				this.syncthingInstance.stdout.on('data', (data: any) => {
					console.log(`stdout: ${data}`);
				});

				this.syncthingInstance.stderr.on('data', (data: any) => {
					console.error(`stderr: ${data}`);
				});

				this.syncthingInstance.on('exit', (code: any) => {
					console.log(`child process exited with code ${code}`);
				});
			}
		});
	}

	stopSyncthing(): void {
		// Mobile mode or mobile platform - nothing to stop locally
		if (this.isMobile || this.settings.mobileMode) {
			console.log('Mobile mode: No local Syncthing to stop');
			return;
		}

		if (this.settings.useDocker)
		{
			if (!exec) {
				console.log('Docker operations not available on mobile platforms');
				return;
			}

			const dockerRunCommand = [
				`docker compose`,
				`-f ${this.getPluginAbsolutePath()}docker/docker-compose.yaml`,
				`stop`,
			];

			exec(dockerRunCommand.join(' '), (error: any, stdout: any, stderr: any) => {
				if (error) {
					console.error('Error:', error.message);
					return false;
				}
				if (stderr) {
					console.log(stderr);
					return false;
				}
	
				console.log('Output:', stdout);
			});
		}
		else
		{
			if (!this.syncthingInstance) {
				console.log('No local Syncthing instance to stop');
				return;
			}

			const pid : number | undefined = this.syncthingInstance?.pid;
			if (pid !== undefined) {
				var kill = require('tree-kill');
				kill(pid, 'SIGTERM', (err: any) => {
					if (err) {
						console.error('Failed to kill process tree:', err);
					} else {
						console.log('Process tree killed successfully.');
					}
				});
			}
		}
	}

	async startSyncthingDockerStack() {
		if (!exec) {
			new Notice('Docker operations not available on mobile platforms', 5000);
			return;
		}

		// Set environment variable
		this.updateEnvFile({
			VAULT_PATH: `${this.vaultPath}`,
			SYNCTHING_CONFIG_PATH: `${this.vaultPath}/.obsidian/syncthing_config`,
		});

		// Run Docker container
		const dockerRunCommand = [
			`docker compose`,
			`-f ${this.getPluginAbsolutePath()}docker/docker-compose.yaml`,
			`up`, 
			`-d`
		];

		exec(dockerRunCommand.join(' '), (error: any, stdout: any, stderr: any) => {
			if (error) {
				console.error('Error:', error.message);
				return false;
			}
			if (stderr) {
				console.log(stderr);
				return false;
			}

			console.log('Output:', stdout);
		});
	};

	updateEnvFile(vars: Record<string, string>) {
		// Skip on mobile platforms where fs is not available
		if (!writeFileSync || !readFileSync) {
			console.log('File system operations not available on mobile platform');
			return;
		}

		const filePath = `${this.getPluginAbsolutePath()}docker/.env`;
		let content = readFileSync(filePath, 'utf8');
	  
		Object.entries(vars).forEach(([key, value]) => {
		  const regex = new RegExp(`^${key}=.*`, 'm');
		  content = content.replace(regex, `${key}=${value}`);
		});
	  
		writeFileSync(filePath, content, 'utf8');
	  }

	getSyncthingURL(): string {
		// Mobile mode or explicit remote URL setting
		if (this.isMobile || this.settings.mobileMode) {
			return this.settings.remoteUrl;
		}
		
		// Desktop mode - Docker or local
		return this.settings.useDocker ? SYNCTHING_CORS_PROXY_CONTAINER_URL : SYNCTHING_CONTAINER_URL;
	}

	async isSyncthingRunning(): Promise<boolean> {
		const config = {
			headers: {
				'X-API-Key': this.settings.syncthingApiKey,
			}
		};

		return axios.get(this.getSyncthingURL() , config)
			.then(response => { return true; })
			.catch(error => { console.log("Syncthing status: Not running"); return false; });
	}

	checkDockerStatus(): boolean {
		if (!exec) {
			console.log('Docker operations not available on mobile platforms');
			return false;
		}

		exec('docker ps', (error: any, stdout: any, stderr: any) => {
			if (error) {
				console.error('Error:', error.message);
				return false;
			}
			if (stderr) {
				console.error('Error:', stderr);
				return false;
			}

			console.log('Output:', stdout);
		});

		return true;
	}

	updateStatusBar(): void {
		this.isSyncthingRunning().then(isRunning => {

			// Display text in status bar
			if (isRunning) {
				this.getLastSyncDate().then(lastSyncDate => {
					if (lastSyncDate !== null)
					{
						const optionsDate: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: '2-digit' };
						const formattedDate = lastSyncDate.toLocaleDateString('en-GB', optionsDate).split( '/' ).join( '.' );

						const optionsTime: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
						const formattedTime = lastSyncDate.toLocaleTimeString('en-GB', optionsTime); 

						this.syncthingLastSyncDate = `${formattedDate} ${formattedTime}`;
					}
					else {
						this.syncthingLastSyncDate = "no data";
					}
				});
			}
			
			// Display status icon in status bar
			if (this.statusBarConnectionIconItem) {
				this.statusBarConnectionIconItem.setText(isRunning ? "🔵" : "⚫");
				this.statusBarConnectionIconItem.ariaLabel = isRunning ? "Syncthing connected (click to stop)" : "Click to start Syncthing";
				this.statusBarConnectionIconItem.addClasses(['plugin-editor-status', 'mouse-pointer']);
			}

			if (this.statusBarLastSyncTextItem) {
				this.statusBarLastSyncTextItem.setText(`Last sync: ${this.syncthingLastSyncDate}`);
			}
		});
	}

	async checkExecutableExists(): Promise<boolean> {
		if (!this.app.vault.adapter || this.isMobile || this.settings.mobileMode) {
			return true; // Not needed on mobile
		}

		try {
			const executablePath = this.getSyncthingExecutablePath();
			
			// Check if file exists using Node.js fs for desktop
			if (typeof require !== 'undefined') {
				try {
					const fs = require('fs');
					return fs.existsSync(executablePath);
				} catch (error) {
					console.error('Error checking file with fs:', error);
				}
			}
			
			return false;
		} catch (error) {
			console.error('Error checking executable:', error);
			return false;
		}
	}

	async downloadSyncthingExecutable(): Promise<boolean> {
		try {
			new Notice('Downloading Syncthing executable... Please wait.', 8000);
			
			// Determine platform and file name
			let fileName: string;
			if (process.platform === 'win32') {
				fileName = 'syncthing-windows.exe';
			} else if (process.platform === 'darwin') {
				fileName = 'syncthing-macos';
			} else {
				fileName = 'syncthing-linux';
			}

			// Download URL from our GitHub release
			const downloadUrl = `https://github.com/muxammadreza/Obsidian-Syncthing-Launcher/releases/download/v${this.manifest.version}/${fileName}`;
			
			// Download the file
			const response = await fetch(downloadUrl);
			if (!response.ok) {
				throw new Error(`Download failed: ${response.statusText}`);
			}

			const arrayBuffer = await response.arrayBuffer();
			const data = new Uint8Array(arrayBuffer);

			// Create syncthing directory if it doesn't exist
			const syncthingDir = `${this.getPluginAbsolutePath()}syncthing`;
			
			if (typeof require !== 'undefined') {
				const fs = require('fs');
				const path = require('path');
				
				// Create directory if it doesn't exist
				if (!fs.existsSync(syncthingDir)) {
					fs.mkdirSync(syncthingDir, { recursive: true });
				}

				// Write the executable file
				const executablePath = this.getSyncthingExecutablePath();
				fs.writeFileSync(executablePath, data);
				
				// Make executable on Unix systems
				if (process.platform !== 'win32') {
					fs.chmodSync(executablePath, '755');
				}
				
				new Notice('Syncthing executable downloaded and installed successfully!', 5000);
				return true;
			} else {
				throw new Error('File system operations not available');
			}

		} catch (error) {
			console.error('Failed to download Syncthing executable:', error);
			new Notice(`Failed to download Syncthing executable: ${error.message}. Please download manually from GitHub release.`, 10000);
			return false;
		}
	}

	detectMobilePlatform(): boolean {
		// Check for mobile platforms using process.platform and user agent
		const platform = process.platform;
		const userAgent = navigator.userAgent.toLowerCase();
		
		// Check for iOS, Android, or mobile browsers
		const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);
		
		// Check for touch support as additional indicator
		const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
		
		// Consider it mobile if user agent suggests mobile or if it's a touch device with small screen
		return isMobileUA || (isTouchDevice && window.innerWidth < 1024);
	}

	getPluginAbsolutePath(): string {
        let basePath;

        // Base path
        if (this.app.vault.adapter instanceof FileSystemAdapter) {
            basePath = this.app.vault.adapter.getBasePath();
        } else {
            throw new Error('Cannot determine base path.');
        }

        // Relative path
        const relativePath = `${this.app.vault.configDir}/plugins/${this.manifest.id}-${this.manifest.version}/`;

        // Absolute path
        return `${basePath}/${relativePath}`;
    }

	getSyncthingExecutablePath(): string {
		const pluginPath = this.getPluginAbsolutePath();
		
		// Detect platform and return appropriate executable path
		if (process.platform === 'win32') {
			return `${pluginPath}syncthing/syncthing.exe`;
		} else if (process.platform === 'darwin') {
			return `${pluginPath}syncthing/syncthing-macos`;
		} else {
			// Linux and other Unix-like systems
			return `${pluginPath}syncthing/syncthing-linux`;
		}
	}

	async getLastSyncDate() {
		try {
		  const response = await axios.get(this.getSyncthingURL() + `rest/db/status?folder=${this.settings.vaultFolderID}`, {
			headers: {
			  'X-API-Key': this.settings.syncthingApiKey,
			}
		  });

		  if (response.data && response.data.stateChanged) {
			return new Date(response.data.stateChanged);
		  } else {
			console.log(response);
			console.log('No sync data found');
			return null;
		  }
		} catch (error) {
		  console.error('Failed to get last sync date:', error);
		  return null;
		}
	}

	// --- Settings ---

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SettingTab extends PluginSettingTab {
	plugin: SyncthingLauncher;

	constructor(app: App, plugin: SyncthingLauncher) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Syncthing API key')
			.setDesc('API key of Syncthing instance (in Syncthing GUI -> Actions -> Settings)')
			.addText(text => text
				.setPlaceholder('Enter Syncthing API key')
				.setValue(this.plugin.settings.syncthingApiKey)
				.onChange(async (value) => {
					this.plugin.settings.syncthingApiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Vault folder ID')
			.setDesc('ID of the folder in which the vault is stored (in Syncthing GUI -> Folders -> Vault folder)')
			.addText(text => text
				.setPlaceholder('Enter vault folder ID')
				.setValue(this.plugin.settings.vaultFolderID)
				.onChange(async (value) => {
					this.plugin.settings.vaultFolderID = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Start on Obsidian open')
			.setDesc('Start Syncthing when Obsidian opens')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.startOnObsidianOpen)
				.onChange(async (value) => {
					this.plugin.settings.startOnObsidianOpen = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Stop on Obsidian close')
			.setDesc('Stop Syncthing when Obsidian closes')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.stopOnObsidianClose)
				.onChange(async (value) => {
					this.plugin.settings.stopOnObsidianClose = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Mobile Mode')
			.setDesc('Enable mobile mode to connect to remote Syncthing instead of running locally (auto-detected)')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.mobileMode)
				.onChange(async (value) => {
					this.plugin.settings.mobileMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Remote Syncthing URL')
			.setDesc('URL of remote Syncthing instance (used in mobile mode or when connecting to remote server)')
			.addText(text => text
				.setPlaceholder('http://192.168.1.100:8384')
				.setValue(this.plugin.settings.remoteUrl)
				.onChange(async (value) => {
					this.plugin.settings.remoteUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Use Docker')
			.setDesc('Run Syncthing in Docker container instead of running it locally (desktop only)')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.useDocker)
				.onChange(async (value) => {
					this.plugin.settings.useDocker = value;
					await this.plugin.saveSettings();
				}));
	}
}
