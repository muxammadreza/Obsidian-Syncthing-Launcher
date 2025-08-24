import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';
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
				
				// Set up configuration directory
				const configDir = `${this.getPluginAbsolutePath()}syncthing-config`;
				if (typeof require !== 'undefined') {
					const fs = require('fs');
					if (!fs.existsSync(configDir)) {
						fs.mkdirSync(configDir, { recursive: true });
					}
				}
				
				// Extract port from remoteUrl if it's localhost, otherwise use default
				let port = '8384';
				if (this.settings.remoteUrl) {
					const urlMatch = this.settings.remoteUrl.match(/^https?:\/\/(127\.0\.0\.1|localhost):(\d+)/);
					if (urlMatch) {
						port = urlMatch[2];
						console.log(`Using custom port ${port} from remoteUrl: ${this.settings.remoteUrl}`);
					} else {
						console.log(`RemoteUrl set but not localhost, using default port 8384: ${this.settings.remoteUrl}`);
					}
				} else {
					console.log(`No remoteUrl set, using default port 8384`);
				}
				
				// Check if port has changed and clear config if needed
				await this.ensureConfigForPort(configDir, port);
				
				// Stop any existing Syncthing instance before starting with new config
				if (this.syncthingInstance) {
					console.log('Stopping existing Syncthing instance before starting with new configuration...');
					await this.stopSyncthing();
					// Wait a moment for clean shutdown
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
				
				// Start Syncthing with configuration directory
				const args = [
					'--home', configDir,
					'--no-browser',
					'--gui-address', `127.0.0.1:${port}`
				];
				
				console.log(`Starting Syncthing with args: ${args.join(' ')}`);
				
				
				this.syncthingInstance = spawn(executablePath, args);

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

	async pauseSyncthing(): Promise<boolean> {
		try {
			const baseUrl = this.getSyncthingURL();
			
			// Mobile mode or mobile platform - pause via API if possible
			if (this.isMobile || this.settings.mobileMode) {
				await axios.post(`${baseUrl}/rest/config/options`, 
					{ ...await this.getSyncthingConfig(), options: { globalAnnEnabled: false } },
					{ headers: { 'X-API-Key': this.settings.syncthingApiKey } }
				);
				return true;
			}

			// For local instances, we can't really "pause" - we would need to stop
			// But we can pause all folders
			const config = await this.getSyncthingConfig();
			
			// Pause all folders
			for (const folder of config.folders) {
				folder.paused = true;
			}
			
			await axios.post(`${baseUrl}/rest/config`, config, {
				headers: { 'X-API-Key': this.settings.syncthingApiKey }
			});
			
			return true;
		} catch (error) {
			console.error('Failed to pause Syncthing:', error);
			return false;
		}
	}

	async resumeSyncthing(): Promise<boolean> {
		try {
			const baseUrl = this.getSyncthingURL();
			
			// Mobile mode or mobile platform - resume via API if possible  
			if (this.isMobile || this.settings.mobileMode) {
				await axios.post(`${baseUrl}/rest/config/options`,
					{ ...await this.getSyncthingConfig(), options: { globalAnnEnabled: true } },
					{ headers: { 'X-API-Key': this.settings.syncthingApiKey } }
				);
				return true;
			}

			// For local instances, resume all folders
			const config = await this.getSyncthingConfig();
			
			// Resume all folders
			for (const folder of config.folders) {
				folder.paused = false;
			}
			
			await axios.post(`${baseUrl}/rest/config`, config, {
				headers: { 'X-API-Key': this.settings.syncthingApiKey }
			});
			
			return true;
		} catch (error) {
			console.error('Failed to resume Syncthing:', error);
			return false;
		}
	}

	async getSyncthingConfig(): Promise<any> {
		const baseUrl = this.getSyncthingURL();
			
		const response = await axios.get(`${baseUrl}/rest/config`, {
			headers: { 'X-API-Key': this.settings.syncthingApiKey }
		});
		
		return response.data;
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

	async ensureConfigForPort(configDir: string, port: string): Promise<void> {
		if (typeof require !== 'undefined') {
			const fs = require('fs');
			const path = require('path');
			
			// Check if we have a stored port to compare against
			const portFile = path.join(configDir, '.syncthing-port');
			let storedPort = '';
			
			if (fs.existsSync(portFile)) {
				try {
					storedPort = fs.readFileSync(portFile, 'utf8').trim();
				} catch (error) {
					console.log('Could not read stored port file:', error);
				}
			}
			
			// If port has changed, clear the config directory
			if (storedPort && storedPort !== port) {
				console.log(`Port changed from ${storedPort} to ${port}, clearing Syncthing config...`);
				
				// Clear all config files except the directory itself
				try {
					const files = fs.readdirSync(configDir);
					for (const file of files) {
						const filePath = path.join(configDir, file);
						const stat = fs.statSync(filePath);
						if (stat.isFile()) {
							fs.unlinkSync(filePath);
							console.log(`Removed config file: ${file}`);
						} else if (stat.isDirectory() && file !== '.' && file !== '..') {
							// Remove subdirectories recursively
							fs.rmSync(filePath, { recursive: true, force: true });
							console.log(`Removed config directory: ${file}`);
						}
					}
				} catch (error) {
					console.log('Error clearing config directory:', error);
				}
			}
			
			// Store the current port
			try {
				fs.writeFileSync(portFile, port, 'utf8');
				console.log(`Stored current port: ${port}`);
			} catch (error) {
				console.log('Could not store port file:', error);
			}
		}
	}	getSyncthingURL(): string {
		// Mobile mode - always use remote URL
		if (this.isMobile || this.settings.mobileMode) {
			console.log(`Using mobile/remote URL: ${this.settings.remoteUrl}`);
			return this.settings.remoteUrl;
		}
		
		// Desktop mode
		if (this.settings.useDocker) {
			console.log(`Using Docker URL: ${SYNCTHING_CORS_PROXY_CONTAINER_URL}`);
			return SYNCTHING_CORS_PROXY_CONTAINER_URL;
		} else {
			// For desktop mode without Docker:
			// Use remoteUrl if set, otherwise default localhost:8384
			if (this.settings.remoteUrl) {
				console.log(`Using configured remoteUrl: ${this.settings.remoteUrl}`);
				return this.settings.remoteUrl;
			}
			console.log(`Using default localhost URL: http://127.0.0.1:8384`);
			return 'http://127.0.0.1:8384';
		}
	}

	async isSyncthingRunning(): Promise<boolean> {
		try {
			const url = this.getSyncthingURL();
			
			// For mobile/remote mode, always try with API key
			if (this.isMobile || this.settings.mobileMode) {
				const config = {
					headers: {
						'X-API-Key': this.settings.syncthingApiKey,
					}
				};
				const response = await axios.get(url, config);
				return response.status === 200;
			}
			
			// For local instances, first try without API key (for initial setup)
			try {
				const response = await axios.get(url);
				return response.status === 200;
			} catch (noAuthError: any) {
				// COMPREHENSIVE ERROR DEBUGGING
				console.log("DEBUG: Full error object:", noAuthError);
				console.log("DEBUG: Error message:", noAuthError.message);
				console.log("DEBUG: Error code:", noAuthError.code);
				console.log("DEBUG: Error response:", noAuthError.response);
				console.log("DEBUG: Error status:", noAuthError.response?.status);
				console.log("DEBUG: Error toString:", noAuthError.toString());
				
				// Enhanced error checking for various success response patterns
				
				// Check standard response object
				if (noAuthError.response && noAuthError.response.status === 200) {
					console.log("SUCCESS: Detected via error.response.status === 200");
					return true;
				}
				
				// Check for ERR_FAILED with 200 OK in message - EXACT pattern from logs
				if (noAuthError.message && noAuthError.message.includes('net::ERR_FAILED 200 (OK)')) {
					console.log("SUCCESS: Detected exact ERR_FAILED 200 (OK) pattern");
					return true;
				}
				
				// Check for any mention of 200 in message
				if (noAuthError.message && (noAuthError.message.includes('200') || noAuthError.message.includes('OK'))) {
					console.log("SUCCESS: Detected 200/OK in error message:", noAuthError.message);
					return true;
				}
				
				// Check error code patterns for successful responses wrapped as errors
				if (noAuthError.code === 'ERR_FAILED') {
					console.log("DEBUG: ERR_FAILED detected, checking message for success indicators");
					if (noAuthError.message && (noAuthError.message.includes('200') || noAuthError.message.includes('OK'))) {
						console.log("SUCCESS: ERR_FAILED with success indicators");
						return true;
					}
				}
				
				// Check for hidden properties that might contain success status
				if (noAuthError.request && noAuthError.request.status === 200) {
					console.log("SUCCESS: Detected via error.request.status === 200");
					return true;
				}
				
				// Check axios specific error patterns
				if (noAuthError.isAxiosError) {
					console.log("DEBUG: This is an axios error");
					// Sometimes axios wraps successful responses as errors
					if (noAuthError.response && noAuthError.response.status >= 200 && noAuthError.response.status < 300) {
						console.log("SUCCESS: Axios error with 2xx status code");
						return true;
					}
				}
				
				// If no-auth fails, try with API key (configured instance)
				if (this.settings.syncthingApiKey) {
					try {
						const config = {
							headers: {
								'X-API-Key': this.settings.syncthingApiKey,
							}
						};
						const response = await axios.get(url, config);
						return response.status === 200;
					} catch (authError: any) {
						console.log("DEBUG: Auth error object:", authError);
						
						// Same comprehensive checking for auth errors
						if (authError.response && authError.response.status === 200) {
							console.log("SUCCESS: Auth request detected via error.response.status === 200");
							return true;
						}
						
						if (authError.message && authError.message.includes('net::ERR_FAILED 200 (OK)')) {
							console.log("SUCCESS: Auth request detected exact ERR_FAILED 200 (OK) pattern");
							return true;
						}
						
						if (authError.message && (authError.message.includes('200') || authError.message.includes('OK'))) {
							console.log("SUCCESS: Auth request detected 200/OK in error message:", authError.message);
							return true;
						}
						
						if (authError.code === 'ERR_FAILED' && authError.message && 
							(authError.message.includes('200') || authError.message.includes('OK'))) {
							console.log("SUCCESS: Auth ERR_FAILED with success indicators");
							return true;
						}
						
						throw authError;
					}
				}
				throw noAuthError;
			}
		} catch (error: any) {
			console.log("DEBUG: Final catch error object:", error);
			
			// Enhanced final error checking with more comprehensive patterns
			if (error.response && error.response.status === 200) {
				console.log("SUCCESS: Final check detected via error.response.status === 200");
				return true;
			}
			
			// Check exact pattern from console logs
			if (error.message && error.message.includes('net::ERR_FAILED 200 (OK)')) {
				console.log("SUCCESS: Final check detected exact ERR_FAILED 200 (OK) pattern");
				return true;
			}
			
			// Check error message for success indicators
			if (error.message && (error.message.includes('200') || error.message.includes('OK'))) {
				console.log("SUCCESS: Final check detected 200/OK in error message:", error.message);
				return true;
			}
			
			// Check for ERR_FAILED with success indicators
			if (error.code === 'ERR_FAILED' && error.message && 
				(error.message.includes('200') || error.message.includes('OK'))) {
				console.log("SUCCESS: Final check detected ERR_FAILED with success indicators");
				return true;
			}
			
			// Try to examine all properties of the error object for hidden success
			try {
				const errorProps = Object.getOwnPropertyNames(error);
				console.log("DEBUG: Error object properties:", errorProps);
				for (const prop of errorProps) {
					const value = error[prop];
					if (typeof value === 'string' && (value.includes('200') || value.includes('OK'))) {
						console.log(`SUCCESS: Found success indicator in property ${prop}: ${value}`);
						return true;
					}
				}
			} catch (e) {
				console.log("DEBUG: Could not examine error properties");
			}
			
			console.log("Syncthing status: Not running");
			return false;
		}
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
			
			// Download the file using Obsidian's requestUrl (bypasses CORS)
			const response = await requestUrl({
				url: downloadUrl,
				method: 'GET'
			});

			const data = new Uint8Array(response.arrayBuffer);

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

		// Status and Control Section
		const statusSection = containerEl.createDiv();
		statusSection.createEl('h2', {text: 'Syncthing Control Panel'});

		// Status display
		const statusSetting = new Setting(statusSection)
			.setName('Syncthing Status')
			.setDesc('Current status of Syncthing service');
		
		const statusButton = statusSetting.addButton(button => button
			.setButtonText('Check Status')
			.setTooltip('Check if Syncthing is running')
			.onClick(async () => {
				const isRunning = await this.plugin.isSyncthingRunning();
				const status = isRunning ? '✅ Running' : '❌ Not running';
				new Notice(`Syncthing status: ${status}`);
				statusIndicator.setText(status);
			}));

		const statusIndicator = statusSetting.settingEl.createSpan();
		statusIndicator.style.marginLeft = '10px';
		statusIndicator.style.fontWeight = 'bold';
		statusIndicator.setText('❓ Unknown');

		// Check initial status
		setTimeout(async () => {
			try {
				const isRunning = await this.plugin.isSyncthingRunning();
				statusIndicator.setText(isRunning ? '✅ Running' : '❌ Not running');
			} catch (error) {
				statusIndicator.setText('❌ Error checking status');
			}
		}, 500);

		// Control buttons
		new Setting(statusSection)
			.setName('Start Syncthing')
			.setDesc('Start the Syncthing service')
			.addButton(button => button
				.setButtonText('Start')
				.setTooltip('Start Syncthing service')
				.onClick(async () => {
					try {
						await this.plugin.startSyncthing();
						new Notice('Syncthing started successfully!');
						// Update status after a short delay
						setTimeout(async () => {
							const isRunning = await this.plugin.isSyncthingRunning();
							statusIndicator.setText(isRunning ? '✅ Running' : '❌ Not running');
						}, 2000);
					} catch (error) {
						new Notice(`Failed to start Syncthing: ${error.message}`);
					}
				}));

		new Setting(statusSection)
			.setName('Stop Syncthing')
			.setDesc('Stop the Syncthing service')
			.addButton(button => button
				.setButtonText('Stop')
				.setTooltip('Stop Syncthing service')
				.onClick(async () => {
					try {
						await this.plugin.stopSyncthing();
						new Notice('Syncthing stopped successfully!');
						statusIndicator.setText('❌ Not running');
					} catch (error) {
						new Notice(`Failed to stop Syncthing: ${error.message}`);
					}
				}));

		new Setting(statusSection)
			.setName('Restart Syncthing')
			.setDesc('Restart the Syncthing service')
			.addButton(button => button
				.setButtonText('Restart')
				.setTooltip('Restart Syncthing service')
				.onClick(async () => {
					try {
						await this.plugin.stopSyncthing();
						await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
						await this.plugin.startSyncthing();
						new Notice('Syncthing restarted successfully!');
						setTimeout(async () => {
							const isRunning = await this.plugin.isSyncthingRunning();
							statusIndicator.setText(isRunning ? '✅ Running' : '❌ Not running');
						}, 2000);
					} catch (error) {
						new Notice(`Failed to restart Syncthing: ${error.message}`);
					}
				}));

		new Setting(statusSection)
			.setName('Pause Syncthing')
			.setDesc('Pause synchronization (keeps Syncthing running but stops syncing)')
			.addButton(button => button
				.setButtonText('Pause')
				.setTooltip('Pause synchronization')
				.onClick(async () => {
					try {
						const success = await this.plugin.pauseSyncthing();
						if (success) {
							new Notice('Syncthing paused successfully!');
						} else {
							new Notice('Failed to pause Syncthing');
						}
					} catch (error) {
						new Notice(`Failed to pause Syncthing: ${error.message}`);
					}
				}));

		new Setting(statusSection)
			.setName('Resume Syncthing')
			.setDesc('Resume synchronization after pausing')
			.addButton(button => button
				.setButtonText('Resume')
				.setTooltip('Resume synchronization')
				.onClick(async () => {
					try {
						const success = await this.plugin.resumeSyncthing();
						if (success) {
							new Notice('Syncthing resumed successfully!');
						} else {
							new Notice('Failed to resume Syncthing');
						}
					} catch (error) {
						new Notice(`Failed to resume Syncthing: ${error.message}`);
					}
				}));

		// Binary Management Section
		const binarySection = containerEl.createDiv();
		binarySection.createEl('h2', {text: 'Binary Management'});

		new Setting(binarySection)
			.setName('Check Executable')
			.setDesc('Check if Syncthing executable exists and is accessible')
			.addButton(button => button
				.setButtonText('Check')
				.setTooltip('Verify Syncthing executable')
				.onClick(async () => {
					const exists = await this.plugin.checkExecutableExists();
					if (exists) {
						new Notice('✅ Syncthing executable found and accessible');
					} else {
						new Notice('❌ Syncthing executable not found');
					}
				}));

		new Setting(binarySection)
			.setName('Download Executable')
			.setDesc('Download the Syncthing executable for your platform')
			.addButton(button => button
				.setButtonText('Download')
				.setTooltip('Download Syncthing binary')
				.onClick(async () => {
					try {
						const success = await this.plugin.downloadSyncthingExecutable();
						if (success) {
							new Notice('✅ Syncthing executable downloaded successfully!');
						} else {
							new Notice('❌ Failed to download Syncthing executable');
						}
					} catch (error) {
						new Notice(`Download failed: ${error.message}`);
					}
				}));

		new Setting(binarySection)
			.setName('Open Syncthing GUI')
			.setDesc('Open Syncthing web interface in browser')
			.addButton(button => button
				.setButtonText('Open GUI')
				.setTooltip('Open Syncthing web interface')
				.onClick(async () => {
					const url = this.plugin.getSyncthingURL();
					window.open(url, '_blank');
				}));

		new Setting(binarySection)
			.setName('Reset Configuration')
			.setDesc('Reset Syncthing configuration (useful for first-time setup or fixing login issues)')
			.addButton(button => button
				.setButtonText('Reset Config')
				.setTooltip('Delete Syncthing configuration to start fresh')
				.onClick(async () => {
					try {
						// Stop Syncthing first
						await this.plugin.stopSyncthing();
						await new Promise(resolve => setTimeout(resolve, 1000));
						
						// Delete config directory
						if (typeof require !== 'undefined') {
							const fs = require('fs');
							const path = require('path');
							const configDir = `${this.plugin.getPluginAbsolutePath()}syncthing-config`;
							
							if (fs.existsSync(configDir)) {
								// Remove directory recursively
								fs.rmSync(configDir, { recursive: true, force: true });
								new Notice('Syncthing configuration reset successfully! Start Syncthing to begin initial setup.');
							} else {
								new Notice('No configuration found to reset.');
							}
						}
					} catch (error) {
						new Notice(`Failed to reset configuration: ${error.message}`);
					}
				}));

		// Configuration Section
		const configSection = containerEl.createDiv();
		configSection.createEl('h2', {text: 'Configuration'});

		new Setting(configSection)
			.setName('Syncthing API key')
			.setDesc('API key of Syncthing instance (in Syncthing GUI -> Actions -> Settings)')
			.addText(text => text
				.setPlaceholder('Enter Syncthing API key')
				.setValue(this.plugin.settings.syncthingApiKey)
				.onChange(async (value) => {
					this.plugin.settings.syncthingApiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(configSection)
			.setName('Vault folder ID')
			.setDesc('ID of the folder in which the vault is stored (in Syncthing GUI -> Folders -> Vault folder)')
			.addText(text => text
				.setPlaceholder('Enter vault folder ID')
				.setValue(this.plugin.settings.vaultFolderID)
				.onChange(async (value) => {
					this.plugin.settings.vaultFolderID = value;
					await this.plugin.saveSettings();
				}));

		new Setting(configSection)
			.setName('Start on Obsidian open')
			.setDesc('Start Syncthing when Obsidian opens')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.startOnObsidianOpen)
				.onChange(async (value) => {
					this.plugin.settings.startOnObsidianOpen = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(configSection)
			.setName('Stop on Obsidian close')
			.setDesc('Stop Syncthing when Obsidian closes')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.stopOnObsidianClose)
				.onChange(async (value) => {
					this.plugin.settings.stopOnObsidianClose = value;
					await this.plugin.saveSettings();
				}));

		new Setting(configSection)
			.setName('Mobile Mode')
			.setDesc('Enable mobile mode to connect to remote Syncthing instead of running locally (auto-detected)')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.mobileMode)
				.onChange(async (value) => {
					this.plugin.settings.mobileMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(configSection)
			.setName('Remote Syncthing URL')
			.setDesc('URL of remote Syncthing instance (used in mobile mode or when connecting to remote server)')
			.addText(text => text
				.setPlaceholder('http://192.168.1.100:8384')
				.setValue(this.plugin.settings.remoteUrl)
				.onChange(async (value) => {
					this.plugin.settings.remoteUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(configSection)
			.setName('Use Docker')
			.setDesc('Run Syncthing in Docker container instead of running it locally (desktop only)')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.useDocker)
				.onChange(async (value) => {
					this.plugin.settings.useDocker = value;
					await this.plugin.saveSettings();
				}));
	}
}
