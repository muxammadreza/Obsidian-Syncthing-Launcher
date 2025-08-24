import * as http from 'http';
import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { EventEmitter } from 'events';

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

interface SyncthingEvent {
	id: number;
	type: string;
	time: string;
	data: any;
}

interface Connection {
	connected: boolean;
}

interface ConnectionsResponse {
	connections: { [key: string]: Connection };
}

/**
 * SyncthingMonitor class using Node.js HTTP module for reliable localhost communication.
 * Based on the proven approach from Diego-Viero/Syncthing-status-icon-Obsidian-plugin.
 */
class SyncthingMonitor extends EventEmitter {
	private token: string | null = null;
	private timeout: number = 1;
	private lastEventId: number | undefined;
	private pollingTimeoutId: NodeJS.Timeout | undefined;
	private isTokenSet: boolean = false;
	private baseUrl: string = 'http://127.0.0.1:8384';
	
	public status: string = "idle";
	public connectedDevicesCount: number = 0;
	public availableDevices: number = 0;
	public fileCompletion: number | undefined;
	public globalItems: number | undefined;
	public needItems: number | undefined;

	public setStatusIcon: (icon: string) => void = () => {};

	public startMonitoring(
		settings: Settings, 
		setStatusIcon: (icon: string) => void,
		baseUrl: string
	) {
		this.token = settings.syncthingApiKey;
		this.timeout = 1; // Use 1 second polling for responsiveness
		this.setStatusIcon = setStatusIcon;
		this.isTokenSet = !!settings.syncthingApiKey;
		this.baseUrl = baseUrl;

		if (this.isTokenSet) {
			this.poll();
			this.checkConnections();
		} else {
			this.status = "API key not set";
			this.setStatusIcon('❌');
			this.emit('status-update', {
				status: this.status,
				fileCompletion: NaN,
				globalItems: NaN,
				needItems: NaN,
				connectedDevicesCount: NaN,
				availableDevices: NaN
			});
		}
	}

	public stopMonitoring() {
		if (this.pollingTimeoutId) {
			clearTimeout(this.pollingTimeoutId);
			this.pollingTimeoutId = undefined;
		}
		this.lastEventId = undefined;
		this.status = "stopped";
		this.emit('disconnected');
	}

	private poll() {
		const lastId = this.lastEventId ?? 0;

		if (!this.token) {
			console.error('Syncthing API token is not set. Cannot poll for events.');
			this.status = "API key not set";
			this.emit('status-update', {
				status: this.status,
				fileCompletion: NaN,
				globalItems: NaN,
				needItems: NaN,
				connectedDevicesCount: NaN,
				availableDevices: NaN
			});
			return;
		}

		// Parse URL for hostname and port
		const url = new URL(this.baseUrl);
		
		// Use IPv6 localhost if hostname is localhost/127.0.0.1
		let hostname = url.hostname;
		if (hostname === 'localhost' || hostname === '127.0.0.1') {
			hostname = '::1'; // Try IPv6 first, fallback in request error handler
		}
		
		const options = {
			hostname: hostname,
			port: parseInt(url.port) || 8384,
			path: `/rest/events?since=${lastId}&timeout=${this.timeout}`,
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${this.token}`,
			}
		};

		const req = http.request(options, (res) => {
			let body = '';

			res.on('data', chunk => {
				body += chunk;
			});

			res.on('end', () => {
				const csrfErrorRegex = /CSRF Error/i;

				if (res.statusCode === 401 || csrfErrorRegex.test(body)) {
					console.error('Syncthing API key is invalid (401 Unauthorized or CSRF Error).');
					this.status = "Invalid API key";
					this.setStatusIcon('❌');
					this.emit('status-update', {
						status: this.status,
						fileCompletion: NaN,
						globalItems: NaN,
						needItems: NaN,
						connectedDevicesCount: NaN,
						availableDevices: NaN
					});
					this.pollingTimeoutId = setTimeout(() => this.poll(), 5000);
					return;
				}

				try {
					const events = JSON.parse(body);

					if (Array.isArray(events)) {
						for (const event of events) {
							this.lastEventId = Math.max(this.lastEventId ?? 0, event.id);
							this.processEvent(event);
						}
					}
				} catch (err) {
					console.error('Failed to parse Syncthing events or unexpected response:', err);
				} finally {
					this.checkConnections();
					this.emit('status-update', {
						status: this.status,
						fileCompletion: this.fileCompletion,
						globalItems: this.globalItems,
						needItems: this.needItems,
						connectedDevicesCount: this.connectedDevicesCount,
						availableDevices: this.availableDevices
					});
					this.pollingTimeoutId = setTimeout(() => this.poll(), this.timeout * 1000);
				}
			});
		});

		req.on('error', (err) => {
			console.error('Syncthing connection error:', err);
			this.status = "Connection error";
			this.setStatusIcon('❌');
			this.pollingTimeoutId = setTimeout(() => this.poll(), 5000);
		});

		req.end();
	}

	private processEvent(event: SyncthingEvent) {
		console.log('Syncthing event:', event.type, event.data);

		switch (event.type) {
			case 'FolderCompletion':
				const completion = event.data.completion;
				const globalItems = event.data.globalItems;
				const needItems = event.data.needItems;
				
				this.fileCompletion = completion;
				this.globalItems = globalItems;
				this.needItems = needItems;

				if (completion !== 100) {
					this.setStatusIcon('🟡');
				} else {
					this.setStatusIcon('🟢');
				}
				break;

			case 'StateChanged':
				const newStatus = event.data.to; // idle, scanning, scan-waiting
				this.status = newStatus;

				if (newStatus === "scanning") {
					this.setStatusIcon('🟡');
				} else if (newStatus === "idle") {
					this.setStatusIcon('🟢');
				}
				break;

			case 'DeviceDisconnected':
				this.setStatusIcon('🔴');
				this.status = "Device disconnected";
				break;

			case 'DeviceConnected':
				this.setStatusIcon('🟢');
				this.status = "Device connected";
				break;

			default:
				// Handle other events as needed
				break;
		}
	}

	private checkConnections() {
		if (!this.token) {
			console.error('Syncthing API token is not set. Cannot check connections.');
			this.status = "API key not set";
			this.emit('status-update', {
				status: this.status,
				fileCompletion: NaN,
				globalItems: NaN,
				needItems: NaN,
				connectedDevicesCount: NaN,
				availableDevices: NaN
			});
			return;
		}

		// Parse URL for hostname and port
		const url = new URL(this.baseUrl);

		// Use IPv6 localhost if hostname is localhost/127.0.0.1
		let hostname = url.hostname;
		if (hostname === 'localhost' || hostname === '127.0.0.1') {
			hostname = '::1'; // Try IPv6 first, fallback in request error handler
		}

		const options = {
			hostname: hostname,
			port: parseInt(url.port) || 8384,
			path: '/rest/system/connections',
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${this.token}`,
			}
		};

		const req = http.request(options, (res) => {
			let body = '';

			res.on('data', chunk => {
				body += chunk;
			});

			res.on('end', () => {
				const csrfErrorRegex = /CSRF Error/i;

				if (res.statusCode === 401 || csrfErrorRegex.test(body)) {
					console.error('Syncthing API key is invalid (401 Unauthorized or CSRF Error).');
					this.status = "Invalid API key";
					return;
				}

				try {
					const data: ConnectionsResponse = JSON.parse(body);
					const connectionsArray = Object.values(data.connections);

					this.availableDevices = connectionsArray.length;
					this.connectedDevicesCount = connectionsArray.filter(conn => conn.connected).length;

					// Update status based on connections
					if (this.connectedDevicesCount === 0) {
						this.setStatusIcon('🔴');
						this.status = "No devices connected";
					} else if (this.status === "idle") {
						this.setStatusIcon('🟢');
					}
				} catch (err) {
					console.error('Failed to parse Syncthing connections or unexpected response:', err);
				} finally {
					this.emit('status-update', {
						status: this.status,
						fileCompletion: this.fileCompletion,
						globalItems: this.globalItems,
						needItems: this.needItems,
						connectedDevicesCount: this.connectedDevicesCount,
						availableDevices: this.availableDevices
					});
				}
			});
		});

		req.on('error', (err) => {
			console.error('Syncthing connections API error:', err);
		});

		req.end();
	}

	/**
	 * Check if Syncthing is running using Node.js HTTP requests
	 */
	public async isSyncthingRunning(): Promise<boolean> {
		return new Promise((resolve) => {
			// Parse URL for hostname and port
			const url = new URL(this.baseUrl);
			
			// Use IPv6 localhost if hostname is localhost/127.0.0.1
			let hostname = url.hostname;
			if (hostname === 'localhost' || hostname === '127.0.0.1') {
				hostname = '::1'; // Try IPv6 first, fallback in request error handler
			}
			
			const options = {
				hostname: hostname,
				port: parseInt(url.port) || 8384,
				path: '/',
				method: 'GET',
				timeout: 2000, // 2 second timeout
			};

			const req = http.request(options, (res) => {
				// If we get any response, Syncthing is running
				resolve(true);
			});

			req.on('error', (err) => {
				console.log('Syncthing connection error:', err.message);
				// ECONNREFUSED means definitely not running
				if (err.message.includes('ECONNREFUSED')) {
					resolve(false);
				} else {
					// Other errors might mean it's running but auth required
					resolve(false);
				}
			});

			req.on('timeout', () => {
				req.destroy();
				resolve(false);
			});

			req.end();
		});
	}
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
	monitor: SyncthingMonitor;

	private statusBarConnectionIconItem: HTMLElement | null = this.addStatusBarItem();
	private statusBarLastSyncTextItem: HTMLElement | null = this.addStatusBarItem();

	async onload() {
		await this.loadSettings();

		// Initialize monitor
		this.monitor = new SyncthingMonitor();

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
			this.monitor.isSyncthingRunning().then(isRunning => {
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

		// Start monitoring with new approach
		this.startStatusMonitoring();

		// Update syncthing the status bar item
		this.updateStatusBar();

		// Register tick interval for last sync date updates
		this.registerInterval(
			window.setInterval(() => this.updateLastSyncDate(), UPDATE_INTERVAL)
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
		this.monitor.stopMonitoring();
	}

	// --- Logic ---

	startStatusMonitoring() {
		if (!this.settings.syncthingApiKey) {
			this.setStatusIcon('❌');
			console.log('No API key set, skipping status monitoring');
			return;
		}

		const baseUrl = this.getSyncthingURL();
		this.monitor.startMonitoring(this.settings, this.setStatusIcon, baseUrl);

		// Listen for status updates
		this.monitor.on('status-update', (data) => {
			// Update status bar with real-time information
			this.updateStatusBarFromMonitor(data);
		});
	}

	private setStatusIcon = (icon: string) => {
		if (this.statusBarConnectionIconItem) {
			this.statusBarConnectionIconItem.setText(icon);
			
			// Update tooltip based on status
			let tooltip = `Syncthing: ${this.monitor.status}`;
			if (this.monitor.availableDevices > 0) {
				tooltip += `\nDevices: ${this.monitor.connectedDevicesCount}/${this.monitor.availableDevices}`;
			}
			if (this.monitor.fileCompletion !== undefined && !isNaN(this.monitor.fileCompletion)) {
				tooltip += `\nSync: ${this.monitor.fileCompletion.toFixed(1)}%`;
			}
			this.statusBarConnectionIconItem.setAttribute('title', tooltip);
			this.statusBarConnectionIconItem.ariaLabel = tooltip;
		}
	}

	private updateStatusBarFromMonitor(data: any) {
		// Update icon based on status
		if (data.status === "Invalid API key") {
			this.setStatusIcon('❌');
		} else if (data.status === "API key not set") {
			this.setStatusIcon('❌');
		} else if (data.connectedDevicesCount === 0) {
			this.setStatusIcon('🔴');
		} else if (data.status === "scanning") {
			this.setStatusIcon('🟡');
		} else if (data.fileCompletion !== undefined && data.fileCompletion < 100) {
			this.setStatusIcon('🟡');
		} else {
			this.setStatusIcon('🟢');
		}
	}

	handleBeforeUnload(event: any) {
		// Kill syncthing if running and set in settings
		if (this.settings.stopOnObsidianClose)
		{
			this.stopSyncthing();
		}
	}

	async startSyncthing() {
		this.monitor.isSyncthingRunning().then(async isRunning => {
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

				// Start monitoring after a short delay to allow Syncthing to start
				setTimeout(() => {
					this.startStatusMonitoring();
				}, 2000);
			}
		});
	}

	stopSyncthing(): void {
		// Stop monitoring
		this.monitor.stopMonitoring();

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

	/**
	 * Use Node.js HTTP for config operations to match the monitoring approach
	 */
	async pauseSyncthing(): Promise<boolean> {
		try {
			const baseUrl = this.getSyncthingURL();
			const config = await this.getSyncthingConfig();
			
			// Pause all folders
			for (const folder of config.folders) {
				folder.paused = true;
			}
			
			return await this.updateSyncthingConfig(config);
		} catch (error) {
			console.error('Failed to pause Syncthing:', error);
			return false;
		}
	}

	async resumeSyncthing(): Promise<boolean> {
		try {
			const baseUrl = this.getSyncthingURL();
			const config = await this.getSyncthingConfig();
			
			// Resume all folders
			for (const folder of config.folders) {
				folder.paused = false;
			}
			
			return await this.updateSyncthingConfig(config);
		} catch (error) {
			console.error('Failed to resume Syncthing:', error);
			return false;
		}
	}

	/**
	 * Get Syncthing config using Node.js HTTP
	 */
	async getSyncthingConfig(): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.settings.syncthingApiKey) {
				reject(new Error('API key not set'));
				return;
			}

			const url = new URL(this.getSyncthingURL());
			
			// Use IPv6 localhost if hostname is localhost/127.0.0.1
			let hostname = url.hostname;
			if (hostname === 'localhost' || hostname === '127.0.0.1') {
				hostname = '::1'; // Try IPv6 first, fallback in request error handler
			}
			
			const options = {
				hostname: hostname,
				port: parseInt(url.port) || 8384,
				path: '/rest/config',
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.syncthingApiKey}`,
				}
			};

			const req = http.request(options, (res) => {
				let body = '';
				res.on('data', chunk => body += chunk);
				res.on('end', () => {
					try {
						resolve(JSON.parse(body));
					} catch (error) {
						reject(error);
					}
				});
			});

			req.on('error', reject);
			req.end();
		});
	}

	/**
	 * Update Syncthing config using Node.js HTTP
	 */
	async updateSyncthingConfig(config: any): Promise<boolean> {
		return new Promise((resolve) => {
			if (!this.settings.syncthingApiKey) {
				resolve(false);
				return;
			}

			const url = new URL(this.getSyncthingURL());
			const postData = JSON.stringify(config);
			
			// Use IPv6 localhost if hostname is localhost/127.0.0.1
			let hostname = url.hostname;
			if (hostname === 'localhost' || hostname === '127.0.0.1') {
				hostname = '::1'; // Try IPv6 first, fallback in request error handler
			}
			
			const options = {
				hostname: hostname,
				port: parseInt(url.port) || 8384,
				path: '/rest/config',
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.settings.syncthingApiKey}`,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(postData)
				}
			};

			const req = http.request(options, (res) => {
				resolve(res.statusCode === 200);
			});

			req.on('error', () => resolve(false));
			req.write(postData);
			req.end();
		});
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
	}

	getSyncthingURL(): string {
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

	/**
	 * Use the monitor's improved status detection
	 */
	async isSyncthingRunning(): Promise<boolean> {
		return await this.monitor.isSyncthingRunning();
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
		this.monitor.isSyncthingRunning().then(isRunning => {
			// Display status icon in status bar
			if (this.statusBarConnectionIconItem) {
				if (!isRunning) {
					this.statusBarConnectionIconItem.setText("⚫");
					this.statusBarConnectionIconItem.ariaLabel = "Click to start Syncthing";
				}
				// If running, the monitor will update the icon via setStatusIcon
				
				this.statusBarConnectionIconItem.addClasses(['plugin-editor-status', 'mouse-pointer']);
			}
		});
	}

	/**
	 * Update last sync date - called periodically
	 */
	updateLastSyncDate(): void {
		this.getLastSyncDate().then(lastSyncDate => {
			if (lastSyncDate !== null) {
				const optionsDate: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: '2-digit' };
				const formattedDate = lastSyncDate.toLocaleDateString('en-GB', optionsDate).split( '/' ).join( '.' );

				const optionsTime: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
				const formattedTime = lastSyncDate.toLocaleTimeString('en-GB', optionsTime); 

				this.syncthingLastSyncDate = `${formattedDate} ${formattedTime}`;
			} else {
				this.syncthingLastSyncDate = "no data";
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

	/**
	 * Download Syncthing executable using official GitHub releases API
	 */
	async downloadSyncthingExecutable(): Promise<boolean> {
		try {
			new Notice('Fetching latest Syncthing release information...', 5000);
			
			// First, get the latest release information from GitHub API
			const releaseInfo = await this.getLatestSyncthingRelease();
			if (!releaseInfo) {
				new Notice('Failed to fetch latest Syncthing release information', 8000);
				return false;
			}

			// Determine platform and architecture
			let platformPattern: string;
			let expectedExecutableName: string;
			
			if (process.platform === 'win32') {
				// Windows - prefer amd64, fall back to 386 if needed
				const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : '386';
				platformPattern = `syncthing-windows-${arch}-v${releaseInfo.version}`;
				expectedExecutableName = 'syncthing.exe';
			} else if (process.platform === 'darwin') {
				// macOS - prefer universal, fall back to specific arch
				if (process.arch === 'arm64') {
					platformPattern = `syncthing-macos-arm64-v${releaseInfo.version}`;
				} else if (process.arch === 'x64') {
					platformPattern = `syncthing-macos-amd64-v${releaseInfo.version}`;
				} else {
					// Try universal first as fallback
					platformPattern = `syncthing-macos-universal-v${releaseInfo.version}`;
				}
				expectedExecutableName = 'syncthing';
			} else {
				// Linux and other Unix-like systems
				const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : '386';
				platformPattern = `syncthing-linux-${arch}-v${releaseInfo.version}`;
				expectedExecutableName = 'syncthing';
			}

			// Find the matching asset
			const asset = releaseInfo.assets.find((asset: any) => 
				asset.name.startsWith(platformPattern)
			);

			if (!asset) {
				new Notice(`No Syncthing release found for ${process.platform} ${process.arch}. Available assets: ${releaseInfo.assets.map((a: any) => a.name).join(', ')}`, 10000);
				return false;
			}

			new Notice(`Downloading Syncthing ${releaseInfo.version} for ${process.platform} ${process.arch}... Please wait.`, 8000);
			console.log(`Downloading Syncthing from: ${asset.browser_download_url}`);

			// Download the archive
			const archiveData = await this.downloadFile(asset.browser_download_url);
			if (!archiveData) {
				new Notice('Failed to download Syncthing archive', 8000);
				return false;
			}

			// Extract and install the executable
			const success = await this.extractAndInstallSyncthing(archiveData, asset.name, expectedExecutableName);
			if (success) {
				new Notice(`Syncthing ${releaseInfo.version} downloaded and installed successfully!`, 5000);
				return true;
			} else {
				new Notice('Failed to extract and install Syncthing executable', 8000);
				return false;
			}

		} catch (error) {
			console.error('Failed to download Syncthing executable:', error);
			new Notice(`Failed to download Syncthing executable: ${error.message}. Please download manually from GitHub release.`, 10000);
			return false;
		}
	}

	/**
	 * Get latest release information from Syncthing GitHub API
	 */
	private async getLatestSyncthingRelease(): Promise<any> {
		return new Promise((resolve, reject) => {
			const https = require('https');
			
			const options = {
				hostname: 'api.github.com',
				port: 443,
				path: '/repos/syncthing/syncthing/releases/latest',
				method: 'GET',
				headers: {
					'User-Agent': 'Obsidian-Syncthing-Launcher-Plugin'
				}
			};

			const req = https.request(options, (res: any) => {
				let data = '';
				
				res.on('data', (chunk: any) => {
					data += chunk;
				});
				
				res.on('end', () => {
					try {
						const releaseData = JSON.parse(data);
						if (res.statusCode !== 200) {
							reject(new Error(`GitHub API error: ${res.statusCode} - ${releaseData.message || 'Unknown error'}`));
							return;
						}
						
						resolve({
							version: releaseData.tag_name.replace('v', ''), // Remove 'v' prefix
							assets: releaseData.assets,
							html_url: releaseData.html_url
						});
					} catch (error) {
						reject(new Error(`Failed to parse GitHub API response: ${error.message}`));
					}
				});
			});

			req.on('error', (error: any) => {
				reject(new Error(`Failed to fetch release info: ${error.message}`));
			});

			req.setTimeout(10000, () => {
				req.destroy();
				reject(new Error('GitHub API request timeout'));
			});

			req.end();
		});
	}

	/**
	 * Download a file using Node.js HTTPS
	 */
	private async downloadFile(url: string): Promise<Buffer | null> {
		return new Promise((resolve) => {
			const https = require('https');
			const urlModule = require('url');
			
			const parsedUrl = urlModule.parse(url);
			
			const options = {
				hostname: parsedUrl.hostname,
				port: 443,
				path: parsedUrl.path,
				method: 'GET',
				headers: {
					'User-Agent': 'Obsidian-Syncthing-Launcher-Plugin'
				}
			};

			const req = https.request(options, (res: any) => {
				if (res.statusCode === 302 || res.statusCode === 301) {
					// Follow redirect
					this.downloadFile(res.headers.location).then(resolve);
					return;
				}
				
				if (res.statusCode !== 200) {
					console.error(`Download failed with status ${res.statusCode}`);
					resolve(null);
					return;
				}

				const chunks: any[] = [];
				res.on('data', (chunk: any) => chunks.push(chunk));
				
				res.on('end', () => {
					resolve(Buffer.concat(chunks));
				});
			});

			req.on('error', (error: any) => {
				console.error('Download failed:', error);
				resolve(null);
			});

			req.setTimeout(60000, () => { // 60 second timeout for large files
				req.destroy();
				console.error('Download timeout');
				resolve(null);
			});

			req.end();
		});
	}

	/**
	 * Extract and install Syncthing executable from downloaded archive
	 */
	private async extractAndInstallSyncthing(archiveData: Buffer, archiveName: string, executableName: string): Promise<boolean> {
		if (typeof require === 'undefined') {
			console.error('File system operations not available');
			return false;
		}

		try {
			const fs = require('fs');
			const path = require('path');
			
			// Create syncthing directory if it doesn't exist
			const syncthingDir = path.join(this.getPluginAbsolutePath(), 'syncthing');
			if (!fs.existsSync(syncthingDir)) {
				fs.mkdirSync(syncthingDir, { recursive: true });
			}

			// Determine if it's a zip or tar.gz file
			const isZip = archiveName.endsWith('.zip');
			const isTarGz = archiveName.endsWith('.tar.gz');

			if (isZip) {
				// Handle ZIP files (Windows, macOS)
				const yauzl = await this.extractZip(archiveData, syncthingDir, executableName);
				return yauzl;
			} else if (isTarGz) {
				// Handle TAR.GZ files (Linux)
				return await this.extractTarGz(archiveData, syncthingDir, executableName);
			} else {
				console.error('Unsupported archive format:', archiveName);
				return false;
			}

		} catch (error) {
			console.error('Failed to extract archive:', error);
			return false;
		}
	}

	/**
	 * Extract ZIP archive (for Windows and macOS)
	 */
	private async extractZip(zipData: Buffer, targetDir: string, executableName: string): Promise<boolean> {
		try {
			// For now, let's use a simple approach - save the archive and use system extraction
			const fs = require('fs');
			const path = require('path');
			const { spawn } = require('child_process');
			
			const tempZipPath = path.join(targetDir, 'temp-syncthing.zip');
			fs.writeFileSync(tempZipPath, zipData);

			// Try to extract using system unzip command
			return new Promise((resolve) => {
				let extractCommand: string;
				let extractArgs: string[];

				if (process.platform === 'win32') {
					// Windows - try PowerShell Expand-Archive
					extractCommand = 'powershell';
					extractArgs = ['-Command', `Expand-Archive -Path "${tempZipPath}" -DestinationPath "${targetDir}" -Force`];
				} else {
					// macOS/Linux - use unzip
					extractCommand = 'unzip';
					extractArgs = ['-o', tempZipPath, '-d', targetDir];
				}

				const extractProcess = spawn(extractCommand, extractArgs);
				
				extractProcess.on('close', (code: number) => {
					try {
						// Clean up temp file
						if (fs.existsSync(tempZipPath)) {
							fs.unlinkSync(tempZipPath);
						}

						if (code === 0) {
							// Find the extracted executable
							this.findAndCopyExecutable(targetDir, executableName).then(resolve);
						} else {
							console.error('Extraction failed with code:', code);
							resolve(false);
						}
					} catch (error) {
						console.error('Post-extraction error:', error);
						resolve(false);
					}
				});

				extractProcess.on('error', (error: any) => {
					console.error('Extraction command failed:', error);
					// Clean up temp file
					try {
						if (fs.existsSync(tempZipPath)) {
							fs.unlinkSync(tempZipPath);
						}
					} catch {}
					resolve(false);
				});
			});

		} catch (error) {
			console.error('ZIP extraction error:', error);
			return false;
		}
	}

	/**
	 * Extract TAR.GZ archive (for Linux)
	 */
	private async extractTarGz(tarData: Buffer, targetDir: string, executableName: string): Promise<boolean> {
		try {
			const fs = require('fs');
			const path = require('path');
			const { spawn } = require('child_process');
			
			const tempTarPath = path.join(targetDir, 'temp-syncthing.tar.gz');
			fs.writeFileSync(tempTarPath, tarData);

			// Extract using tar command
			return new Promise((resolve) => {
				const extractProcess = spawn('tar', ['-xzf', tempTarPath, '-C', targetDir]);
				
				extractProcess.on('close', (code: number) => {
					try {
						// Clean up temp file
						if (fs.existsSync(tempTarPath)) {
							fs.unlinkSync(tempTarPath);
						}

						if (code === 0) {
							// Find the extracted executable
							this.findAndCopyExecutable(targetDir, executableName).then(resolve);
						} else {
							console.error('TAR extraction failed with code:', code);
							resolve(false);
						}
					} catch (error) {
						console.error('Post-extraction error:', error);
						resolve(false);
					}
				});

				extractProcess.on('error', (error: any) => {
					console.error('TAR extraction command failed:', error);
					// Clean up temp file
					try {
						if (fs.existsSync(tempTarPath)) {
							fs.unlinkSync(tempTarPath);
						}
					} catch {}
					resolve(false);
				});
			});

		} catch (error) {
			console.error('TAR.GZ extraction error:', error);
			return false;
		}
	}

	/**
	 * Find and copy the Syncthing executable to the final location
	 */
	private async findAndCopyExecutable(extractDir: string, executableName: string): Promise<boolean> {
		try {
			const fs = require('fs');
			const path = require('path');

			// Recursively search for the executable
			const findExecutable = (dir: string): string | null => {
				const items = fs.readdirSync(dir);
				
				for (const item of items) {
					const itemPath = path.join(dir, item);
					const stat = fs.statSync(itemPath);
					
					if (stat.isFile() && item === executableName) {
						return itemPath;
					} else if (stat.isDirectory()) {
						const found = findExecutable(itemPath);
						if (found) return found;
					}
				}
				return null;
			};

			const executablePath = findExecutable(extractDir);
			if (!executablePath) {
				console.error(`Executable ${executableName} not found in extracted archive`);
				return false;
			}

			// Copy to final location based on platform
			let finalPath: string;
			if (process.platform === 'win32') {
				finalPath = path.join(extractDir, 'syncthing.exe');
			} else if (process.platform === 'darwin') {
				finalPath = path.join(extractDir, 'syncthing-macos');
			} else {
				finalPath = path.join(extractDir, 'syncthing-linux');
			}

			// Copy the executable
			fs.copyFileSync(executablePath, finalPath);
			
			// Make executable on Unix systems
			if (process.platform !== 'win32') {
				fs.chmodSync(finalPath, '755');
			}

			// Clean up extracted directory structure, keep only our renamed executable
			this.cleanupExtractedFiles(extractDir, path.basename(finalPath));

			console.log(`Syncthing executable installed to: ${finalPath}`);
			return true;

		} catch (error) {
			console.error('Failed to find and copy executable:', error);
			return false;
		}
	}

	/**
	 * Clean up extracted files, keeping only the renamed executable
	 */
	private cleanupExtractedFiles(dir: string, keepFile: string): void {
		try {
			const fs = require('fs');
			const path = require('path');

			const items = fs.readdirSync(dir);
			
			for (const item of items) {
				if (item === keepFile) continue; // Keep our executable
				
				const itemPath = path.join(dir, item);
				const stat = fs.statSync(itemPath);
				
				if (stat.isDirectory()) {
					// Remove directory recursively
					fs.rmSync(itemPath, { recursive: true, force: true });
				} else {
					// Remove file
					fs.unlinkSync(itemPath);
				}
			}
		} catch (error) {
			console.error('Cleanup error (non-fatal):', error);
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

	/**
	 * Get the last sync date using Node.js HTTP
	 */
	async getLastSyncDate() {
		return new Promise<Date | null>((resolve) => {
			if (!this.settings.syncthingApiKey || !this.settings.vaultFolderID) {
				resolve(null);
				return;
			}

			const url = new URL(this.getSyncthingURL());
			
			// Use IPv6 localhost if hostname is localhost/127.0.0.1
			let hostname = url.hostname;
			if (hostname === 'localhost' || hostname === '127.0.0.1') {
				hostname = '::1'; // Try IPv6 first, fallback in request error handler
			}
			
			const options = {
				hostname: hostname,
				port: parseInt(url.port) || 8384,
				path: `/rest/db/status?folder=${this.settings.vaultFolderID}`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.settings.syncthingApiKey}`,
				}
			};

			const req = http.request(options, (res) => {
				let body = '';
				res.on('data', chunk => body += chunk);
				res.on('end', () => {
					try {
						const data = JSON.parse(body);
						if (data.stateChanged) {
							resolve(new Date(data.stateChanged));
						} else {
							resolve(null);
						}
					} catch (error) {
						console.error('Failed to parse sync date response:', error);
						resolve(null);
					}
				});
			});

			req.on('error', (error) => {
				console.error('Failed to get last sync date:', error);
				resolve(null);
			});

			req.end();
		});
	}

	// --- Settings ---

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Restart monitoring with new settings
		this.monitor.stopMonitoring();
		setTimeout(() => {
			this.startStatusMonitoring();
		}, 1000);
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

		// Real-time status updates from monitor
		const updateStatusFromMonitor = (data: any) => {
			let statusText = '❓ Unknown';
			if (data.status === "Invalid API key") {
				statusText = '❌ Invalid API key';
			} else if (data.status === "API key not set") {
				statusText = '❌ API key not set';
			} else if (data.connectedDevicesCount === 0) {
				statusText = '🔴 No devices connected';
			} else if (data.status === "scanning") {
				statusText = '🟡 Scanning';
			} else if (data.fileCompletion !== undefined && data.fileCompletion < 100) {
				statusText = `🟡 Syncing (${data.fileCompletion.toFixed(1)}%)`;
			} else {
				statusText = '🟢 Connected';
			}
			statusIndicator.setText(statusText);
		};

		this.plugin.monitor.on('status-update', updateStatusFromMonitor);

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
