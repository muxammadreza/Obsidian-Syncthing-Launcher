import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { EventEmitter } from 'events';

// Platform detection for mobile
function detectMobilePlatform(): boolean {
	// Check if we're running in Obsidian mobile
	if ((window as any).app?.isMobile) {
		return true;
	}
	
	// Check user agent for mobile platforms
	const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
	
	// iOS detection
	if (/iPad|iPhone|iPod/.test(userAgent)) {
		return true;
	}
	
	// Android detection
	if (/android/i.test(userAgent)) {
		return true;
	}
	
	// Additional mobile checks
	if (/Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) {
		return true;
	}
	
	return false;
}

// Conditional imports for desktop-only functionality
let spawn: any, exec: any, readFileSync: any, writeFileSync: any, http: any;
let fs: any, path: any, childProcess: any, treeKill: any, https: any, urlModule: any;

try {
	// Only load Node.js modules on desktop platforms
	if (!detectMobilePlatform()) {
		childProcess = require("child_process");
		fs = require('fs');
		path = require('path');
		http = require('http');
		https = require('https');
		urlModule = require('url');
		treeKill = require('tree-kill');
		
		spawn = childProcess.spawn;
		exec = childProcess.exec;
		readFileSync = fs.readFileSync;
		writeFileSync = fs.writeFileSync;
	} else {
		// On mobile, provide no-op functions
		console.log('Mobile platform detected - Node.js functionality disabled');
		http = {
			request: () => { throw new Error('HTTP requests not available on mobile platform'); }
		};
		fs = {
			existsSync: () => false,
			readFileSync: () => '',
			writeFileSync: () => {},
			accessSync: () => { throw new Error('File access not available on mobile'); },
			constants: { F_OK: 0, X_OK: 1 },
			chmodSync: () => {}
		};
		childProcess = {
			spawn: () => { throw new Error('Process spawning not available on mobile'); },
			exec: () => { throw new Error('Process execution not available on mobile'); }
		};
	}
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
				'X-API-Key': this.token,
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
				'X-API-Key': this.token,
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
			
			// Use IPv4 localhost instead of IPv6 to avoid connection issues
			let hostname = url.hostname;
			if (hostname === 'localhost') {
				hostname = '127.0.0.1'; // Use IPv4 instead of IPv6
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
				
				try {
					this.syncthingInstance = spawn(executablePath, args);
				} catch (spawnError) {
					console.error('Failed to spawn Syncthing process:', spawnError);
					new Notice(`Failed to start Syncthing: ${spawnError.message}. Try re-downloading the executable.`, 10000);
					return;
				}

				this.syncthingInstance.stdout.on('data', (data: any) => {
					console.log(`stdout: ${data}`);
				});

				this.syncthingInstance.stderr.on('data', (data: any) => {
					console.error(`stderr: ${data}`);
				});

				this.syncthingInstance.on('exit', (code: any) => {
					console.log(`child process exited with code ${code}`);
				});

				this.syncthingInstance.on('error', (error: any) => {
					console.error('Syncthing process error:', error);
					if (error.code === 'ENOEXEC') {
						new Notice('Syncthing executable cannot be run. This may be due to permission issues or corrupted download. Try re-downloading the executable.', 15000);
					} else {
						new Notice(`Syncthing process error: ${error.message}`, 10000);
					}
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

		if (this.settings.useDocker) {
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
		} else {
			// Enhanced process stopping - kill ALL Syncthing processes
			this.killAllSyncthingProcesses();
		}
	}

	/**
	 * Kill all Syncthing processes to prevent orphaned instances
	 */
	private killAllSyncthingProcesses(): void {
		// First try to stop the tracked instance
		if (this.syncthingInstance) {
			const pid: number | undefined = this.syncthingInstance?.pid;
			if (pid !== undefined) {
				var kill = require('tree-kill');
				kill(pid, 'SIGTERM', (err: any) => {
					if (err) {
						console.error('Failed to kill tracked process tree:', err);
					} else {
						console.log('Tracked process tree killed successfully.');
					}
				});
			}
			// Clear the instance reference
			this.syncthingInstance = null;
		}

		// Then try to kill any other Syncthing processes by name
		if (exec) {
			let killCommand: string;
			
			if (process.platform === 'win32') {
				// Windows: Kill by process name
				killCommand = 'taskkill /F /IM syncthing.exe /T';
			} else {
				// Unix-like: Kill by process name
				killCommand = 'pkill -f syncthing';
			}

			exec(killCommand, (error: any, stdout: any, stderr: any) => {
				if (error) {
					// Not finding processes to kill is not an error
					if (!error.message.includes('not found') && !error.message.includes('No such process')) {
						console.log('Error killing Syncthing processes:', error.message);
					}
				} else {
					console.log('All Syncthing processes terminated');
				}
			});
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
			
			// Use IPv4 localhost instead of IPv6 to avoid connection issues
			let hostname = url.hostname;
			if (hostname === 'localhost') {
				hostname = '127.0.0.1'; // Use IPv4 instead of IPv6
			}
			
			const options = {
				hostname: hostname,
				port: parseInt(url.port) || 8384,
				path: '/rest/config',
				method: 'GET',
				headers: {
					'X-API-Key': this.settings.syncthingApiKey,
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
			
			// Use IPv4 localhost instead of IPv6 to avoid connection issues
			let hostname = url.hostname;
			if (hostname === 'localhost') {
				hostname = '127.0.0.1'; // Use IPv4 instead of IPv6
			}
			
			const options = {
				hostname: hostname,
				port: parseInt(url.port) || 8384,
				path: '/rest/config',
				method: 'POST',
				headers: {
					'X-API-Key': this.settings.syncthingApiKey,
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
					
					// Check if file exists
					if (!fs.existsSync(executablePath)) {
						console.log('Executable file does not exist:', executablePath);
						return false;
					}
					
					// Check if file is executable
					try {
						fs.accessSync(executablePath, fs.constants.F_OK | fs.constants.X_OK);
						console.log('✅ Executable exists and is executable:', executablePath);
						return true;
					} catch (permError) {
						console.log('❌ Executable exists but is not executable:', executablePath, permError.message);
						
						// Try to fix permissions if it's a permission issue
						if (process.platform !== 'win32') {
							try {
								fs.chmodSync(executablePath, '755');
								console.log('Fixed executable permissions');
								
								// Try again after fixing permissions
								fs.accessSync(executablePath, fs.constants.F_OK | fs.constants.X_OK);
								console.log('✅ Executable permissions fixed');
								return true;
							} catch (fixError) {
								console.log('❌ Could not fix executable permissions:', fixError.message);
								return false;
							}
						}
						return false;
					}
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
			
			console.log(`Detected platform: ${process.platform}, architecture: ${process.arch}`);
			
			if (process.platform === 'win32') {
				// Windows - prefer amd64, fall back to 386 if needed
				const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : '386';
				platformPattern = `syncthing-windows-${arch}-v${releaseInfo.version}`;
				expectedExecutableName = 'syncthing.exe';
			} else if (process.platform === 'darwin') {
				// macOS - be more specific about architecture selection
				let arch: string;
				if (process.arch === 'arm64') {
					arch = 'arm64';
				} else if (process.arch === 'x64') {
					arch = 'amd64';
				} else {
					// For unknown architectures, try universal first
					console.log(`Unknown macOS architecture ${process.arch}, trying universal build`);
					arch = 'universal';
				}
				platformPattern = `syncthing-macos-${arch}-v${releaseInfo.version}`;
				expectedExecutableName = 'syncthing';
				console.log(`Selected macOS pattern: ${platformPattern}`);
			} else {
				// Linux and other Unix-like systems
				const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : '386';
				platformPattern = `syncthing-linux-${arch}-v${releaseInfo.version}`;
				expectedExecutableName = 'syncthing';
			}

			console.log(`Looking for release asset matching: ${platformPattern}`);
			console.log(`Available assets: ${releaseInfo.assets.map((a: any) => a.name).join(', ')}`);

			// Find the matching asset
			const asset = releaseInfo.assets.find((asset: any) => 
				asset.name.startsWith(platformPattern)
			);

			if (!asset) {
				// For macOS, try fallback strategies
				if (process.platform === 'darwin') {
					console.log('Primary macOS asset not found, trying fallbacks...');
					
					// Try universal build
					const universalPattern = `syncthing-macos-universal-v${releaseInfo.version}`;
					const universalAsset = releaseInfo.assets.find((asset: any) => 
						asset.name.startsWith(universalPattern)
					);
					
					if (universalAsset) {
						console.log(`Found universal macOS build: ${universalAsset.name}`);
						new Notice(`Using universal macOS build for ${process.arch} architecture`, 5000);
						return this.downloadAndInstallAsset(universalAsset, expectedExecutableName);
					}
					
					// Try amd64 as final fallback for x64 systems
					if (process.arch === 'x64') {
						const amd64Pattern = `syncthing-macos-amd64-v${releaseInfo.version}`;
						const amd64Asset = releaseInfo.assets.find((asset: any) => 
							asset.name.startsWith(amd64Pattern)
						);
						
						if (amd64Asset) {
							console.log(`Found amd64 macOS build: ${amd64Asset.name}`);
							new Notice(`Using amd64 macOS build for x64 architecture`, 5000);
							return this.downloadAndInstallAsset(amd64Asset, expectedExecutableName);
						}
					}
				}

				new Notice(`No Syncthing release found for ${process.platform} ${process.arch}. Available assets: ${releaseInfo.assets.map((a: any) => a.name).join(', ')}`, 10000);
				return false;
			}

			return this.downloadAndInstallAsset(asset, expectedExecutableName);

		} catch (error) {
			console.error('Failed to download Syncthing executable:', error);
			new Notice(`Failed to download Syncthing executable: ${error.message}. Please download manually from GitHub release.`, 10000);
			return false;
		}
	}

	/**
	 * Download and install a specific asset
	 */
	private async downloadAndInstallAsset(asset: any, expectedExecutableName: string): Promise<boolean> {
		try {
			new Notice(`Downloading Syncthing ${asset.name.match(/v(\d+\.\d+\.\d+)/)?.[1] || 'latest'} for ${process.platform} ${process.arch}... Please wait.`, 8000);
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
				const version = asset.name.match(/v(\d+\.\d+\.\d+)/)?.[1] || 'latest';
				new Notice(`Syncthing ${version} downloaded and installed successfully!`, 5000);
				return true;
			} else {
				new Notice('Failed to extract and install Syncthing executable', 8000);
				return false;
			}
		} catch (error) {
			console.error('Failed to download and install asset:', error);
			new Notice(`Failed to download and install: ${error.message}`, 8000);
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
			console.log(`Saved ZIP archive to: ${tempZipPath} (${zipData.length} bytes)`);

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

				console.log(`Extracting with command: ${extractCommand} ${extractArgs.join(' ')}`);
				const extractProcess = spawn(extractCommand, extractArgs);
				
				let stdout = '';
				let stderr = '';
				
				extractProcess.stdout?.on('data', (data: any) => {
					stdout += data.toString();
				});
				
				extractProcess.stderr?.on('data', (data: any) => {
					stderr += data.toString();
				});
				
				extractProcess.on('close', (code: number) => {
					console.log(`Extraction completed with code: ${code}`);
					if (stdout) console.log(`Extraction stdout: ${stdout}`);
					if (stderr) console.log(`Extraction stderr: ${stderr}`);
					
					try {
						// Clean up temp file
						if (fs.existsSync(tempZipPath)) {
							fs.unlinkSync(tempZipPath);
							console.log('Cleaned up temporary ZIP file');
						}

						if (code === 0) {
							// List contents of target directory for debugging
							try {
								const contents = fs.readdirSync(targetDir);
								console.log(`Contents of ${targetDir}: ${contents.join(', ')}`);
							} catch (listError) {
								console.log('Could not list directory contents:', listError);
							}
							
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
			const { exec } = require('child_process');

			console.log(`Looking for executable "${executableName}" in: ${extractDir}`);

			// Recursively search for the executable with priority for root-level files
			const findExecutable = (dir: string): string | null => {
				const items = fs.readdirSync(dir);
				console.log(`Searching in ${dir}: found items: ${items.join(', ')}`);
				
				// First pass: look for the executable in the current directory (prioritize root level)
				for (const item of items) {
					const itemPath = path.join(dir, item);
					const stat = fs.statSync(itemPath);
					
					if (stat.isFile() && item === executableName) {
						// Additional validation - check if it's actually a binary executable
						try {
							const sizeInMB = (stat.size / 1024 / 1024).toFixed(1);
							console.log(`Found potential executable: ${itemPath} (${stat.size} bytes = ${sizeInMB} MB)`);
							
							// Syncthing binaries are typically 10+ MB, so anything under 1MB is likely a config file
							if (stat.size > 1024 * 1024) { // > 1MB
								console.log(`✅ Found legitimate executable: ${itemPath}`);
								return itemPath;
							} else {
								console.log(`⚠️ Skipping small file (likely config): ${itemPath} (${stat.size} bytes)`);
							}
						} catch (statError) {
							console.log(`Could not stat file: ${itemPath}`, statError);
						}
					}
				}
				
				// Second pass: search subdirectories if we didn't find it at this level
				for (const item of items) {
					const itemPath = path.join(dir, item);
					const stat = fs.statSync(itemPath);
					
					if (stat.isDirectory()) {
						const found = findExecutable(itemPath);
						if (found) return found;
					}
				}
				return null;
			};

			const executablePath = findExecutable(extractDir);
			if (!executablePath) {
				console.error(`❌ Executable ${executableName} not found in extracted archive`);
				return false;
			}

			// Additional validation - verify it's actually a proper binary
			const execStats = fs.statSync(executablePath);
			const execSizeInMB = (execStats.size / 1024 / 1024).toFixed(1);
			console.log(`Selected executable: ${executablePath} (${execStats.size} bytes = ${execSizeInMB} MB)`);
			
			if (execStats.size < 1024 * 1024) { // Less than 1MB
				console.error(`❌ Selected file is too small to be a Syncthing binary (${execStats.size} bytes). This is likely a config file, not the executable.`);
				return false;
			}

			// On macOS, check if it's a Mach-O binary
			if (process.platform === 'darwin') {
				try {
					const fileTypeCheck = await new Promise<string>((resolve) => {
						exec(`file "${executablePath}"`, (error: any, stdout: any) => {
							resolve(stdout || 'Could not determine file type');
						});
					});
					console.log(`Pre-copy file type check: ${fileTypeCheck.trim()}`);
					
					if (fileTypeCheck.includes('ASCII text') || fileTypeCheck.includes('text')) {
						console.error(`❌ Selected file is a text file, not a binary: ${fileTypeCheck.trim()}`);
						return false;
					}
				} catch (typeError) {
					console.log('Could not verify file type (non-fatal):', typeError);
				}
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

			console.log(`Copying executable from ${executablePath} to ${finalPath}`);

			// Copy the executable
			fs.copyFileSync(executablePath, finalPath);
			console.log(`✅ Executable copied successfully`);
			
			// Make executable on Unix systems and handle macOS security
			if (process.platform !== 'win32') {
				fs.chmodSync(finalPath, '755');
				console.log('✅ Set executable permissions (755)');
				
				// On macOS, remove quarantine attributes to allow execution
				if (process.platform === 'darwin') {
					try {
						await new Promise<void>((resolve, reject) => {
							exec(`xattr -d com.apple.quarantine "${finalPath}"`, (error: any) => {
								// Don't reject if the attribute doesn't exist
								if (error && !error.message.includes('No such xattr')) {
									console.log('Note: Could not remove quarantine attribute:', error.message);
								} else {
									console.log('✅ Removed macOS quarantine attribute from executable');
								}
								resolve();
							});
						});
					} catch (error) {
						console.log('Note: Could not remove quarantine attribute (non-fatal):', error);
					}
					
					// Additional debugging for macOS
					try {
						const fileTypeOutput = await new Promise<string>((resolve) => {
							exec(`file "${finalPath}"`, (error: any, stdout: any) => {
								resolve(stdout || 'Could not determine file type');
							});
						});
						console.log(`File type check: ${fileTypeOutput.trim()}`);
						
						const archOutput = await new Promise<string>((resolve) => {
							exec(`lipo -info "${finalPath}" 2>/dev/null || otool -hv "${finalPath}" 2>/dev/null || echo "Not a Mach-O binary"`, (error: any, stdout: any) => {
								resolve(stdout || 'Could not determine architecture');
							});
						});
						console.log(`Architecture check: ${archOutput.trim()}`);
					} catch (debugError) {
						console.log('Debug checks failed (non-fatal):', debugError);
					}
				}
			}

			// Clean up extracted directory structure, keep only our renamed executable
			this.cleanupExtractedFiles(extractDir, path.basename(finalPath));

			console.log(`Syncthing executable installed to: ${finalPath}`);
			
			// Verify the executable is actually executable
			try {
				const stats = fs.statSync(finalPath);
				const mode = stats.mode;
				console.log(`Executable permissions: ${(mode & parseInt('777', 8)).toString(8)}`);
				console.log(`File size: ${stats.size} bytes`);
				
				// Test if we can access the file for execution
				fs.accessSync(finalPath, fs.constants.F_OK | fs.constants.X_OK);
				console.log('✅ Executable permissions verified');
				
				// Try a quick execution test on macOS to see if it actually works
				if (process.platform === 'darwin') {
					try {
						const testOutput = await new Promise<string>((resolve, reject) => {
							exec(`"${finalPath}" --version`, { timeout: 5000 }, (error: any, stdout: any, stderr: any) => {
								if (error) {
									reject(error);
								} else {
									resolve(stdout.trim());
								}
							});
						});
						console.log('✅ Executable test run successful:', testOutput.split('\n')[0]);
					} catch (testError) {
						console.log('❌ Executable test run failed:', testError.message);
						console.log('This indicates the binary may not be compatible or corrupted');
						return false;
					}
				}
			} catch (permError) {
				console.error('❌ Executable permissions issue:', permError);
				throw new Error(`Executable not accessible: ${permError.message}`);
			}

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
		return detectMobilePlatform();
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
					'X-API-Key': this.settings.syncthingApiKey,
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
	private activeTab = 'overview';
	private refreshInterval: NodeJS.Timeout | null = null;

	constructor(app: App, plugin: SyncthingLauncher) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Main container
		containerEl.createDiv('syncthing-settings', (settingsEl) => {
			// Tab navigation
			const tabsEl = settingsEl.createDiv('syncthing-tabs');
			
			const tabs = [
				{ id: 'overview', label: 'Overview', icon: '📊' },
				{ id: 'configuration', label: 'Configuration', icon: '⚙️' },
				{ id: 'advanced', label: 'Advanced', icon: '🔧' },
				{ id: 'about', label: 'About', icon: 'ℹ️' }
			];

			tabs.forEach(tab => {
				const tabEl = tabsEl.createEl('button', {
					cls: `syncthing-tab ${this.activeTab === tab.id ? 'active' : ''}`,
					text: `${tab.icon} ${tab.label}`
				});
				
				tabEl.addEventListener('click', () => {
					this.activeTab = tab.id;
					this.display();
				});
			});

			// Tab content
			this.renderTabContent(settingsEl);
		});

		// Auto-refresh overview tab
		if (this.activeTab === 'overview') {
			this.startAutoRefresh();
		}
	}

	private renderTabContent(container: HTMLElement): void {
		const contentEl = container.createDiv('syncthing-tab-content active');

		switch (this.activeTab) {
			case 'overview':
				this.renderOverviewTab(contentEl);
				break;
			case 'configuration':
				this.renderConfigurationTab(contentEl);
				break;
			case 'advanced':
				this.renderAdvancedTab(contentEl);
				break;
			case 'about':
				this.renderAboutTab(contentEl);
				break;
		}
	}

	private renderOverviewTab(container: HTMLElement): void {
		// Status Card
		const statusCard = container.createDiv('syncthing-status-card');
		
		const statusHeader = statusCard.createDiv('syncthing-status-header');
		statusHeader.createEl('h2', { cls: 'syncthing-status-title', text: 'Syncthing Status' });
		
		const statusIndicator = statusHeader.createSpan('syncthing-status-indicator unknown');
		statusIndicator.textContent = 'Checking...';

		// Status info grid
		const statusInfo = statusCard.createDiv('syncthing-status-info');
		
		const executableItem = statusInfo.createDiv('syncthing-info-item');
		executableItem.createDiv({ cls: 'syncthing-info-label', text: 'Executable' });
		const executableValue = executableItem.createDiv('syncthing-info-value');
		
		// Check executable status based on platform
		if (this.plugin.detectMobilePlatform() || this.plugin.settings.mobileMode) {
			executableValue.textContent = 'Remote Mode';
		} else {
			this.plugin.checkExecutableExists().then(exists => {
				executableValue.textContent = exists ? 'Found' : 'Not found';
			});
		}

		const configItem = statusInfo.createDiv('syncthing-info-item');
		configItem.createDiv({ cls: 'syncthing-info-label', text: 'API Key' });
		const configValue = configItem.createDiv('syncthing-info-value');
		configValue.textContent = this.plugin.settings.syncthingApiKey ? 'Configured' : 'Not configured';

		const modeItem = statusInfo.createDiv('syncthing-info-item');
		modeItem.createDiv({ cls: 'syncthing-info-label', text: 'Mode' });
		const modeValue = modeItem.createDiv('syncthing-info-value');
		const mode = this.plugin.detectMobilePlatform() ? 'Mobile' : (this.plugin.settings.mobileMode ? 'Remote' : 'Desktop');
		modeValue.textContent = mode;

		const urlItem = statusInfo.createDiv('syncthing-info-item');
		urlItem.createDiv({ cls: 'syncthing-info-label', text: 'URL' });
		const urlValue = urlItem.createDiv('syncthing-info-value');
		urlValue.textContent = this.plugin.getSyncthingURL();

		// Additional status info from monitor
		const devicesItem = statusInfo.createDiv('syncthing-info-item');
		devicesItem.createDiv({ cls: 'syncthing-info-label', text: 'Devices' });
		const devicesValue = devicesItem.createDiv('syncthing-info-value');
		devicesValue.textContent = '0/0';

		const syncItem = statusInfo.createDiv('syncthing-info-item');
		syncItem.createDiv({ cls: 'syncthing-info-label', text: 'Sync Progress' });
		const syncValue = syncItem.createDiv('syncthing-info-value');
		syncValue.textContent = 'Unknown';

		// Controls - adapt based on platform
		const controls = statusCard.createDiv('syncthing-controls');
		
		if (!this.plugin.detectMobilePlatform() && !this.plugin.settings.mobileMode) {
			// Desktop controls
			const startBtn = controls.createEl('button', {
				cls: 'syncthing-btn success',
				text: '🚀 Start'
			});
			startBtn.addEventListener('click', async () => {
				try {
					await this.plugin.startSyncthing();
					new Notice('Syncthing started successfully');
					this.updateStatus();
				} catch (error) {
					new Notice(`Failed to start Syncthing: ${error.message}`);
				}
			});

			const stopBtn = controls.createEl('button', {
				cls: 'syncthing-btn danger',
				text: '⏹️ Stop'
			});
			stopBtn.addEventListener('click', async () => {
				try {
					await this.plugin.stopSyncthing();
					new Notice('Syncthing stopped');
					this.updateStatus();
				} catch (error) {
					new Notice(`Failed to stop Syncthing: ${error.message}`);
				}
			});

			const restartBtn = controls.createEl('button', {
				cls: 'syncthing-btn secondary',
				text: '🔄 Restart'
			});
			restartBtn.addEventListener('click', async () => {
				try {
					await this.plugin.stopSyncthing();
					await new Promise(resolve => setTimeout(resolve, 2000)); // Wait longer for cleanup
					await this.plugin.startSyncthing();
					new Notice('Syncthing restarted');
					this.updateStatus();
				} catch (error) {
					new Notice(`Failed to restart Syncthing: ${error.message}`);
				}
			});
		}

		// Universal controls (work on both desktop and mobile)
		const openBtn = controls.createEl('button', {
			cls: 'syncthing-btn primary',
			text: '🌐 Open GUI'
		});
		openBtn.addEventListener('click', () => {
			const url = this.plugin.getSyncthingURL();
			window.open(url, '_blank');
		});

		const refreshBtn = controls.createEl('button', {
			cls: 'syncthing-btn secondary',
			text: '🔄 Refresh Status'
		});
		refreshBtn.addEventListener('click', () => this.updateStatus());

		// Wire up real-time status updates from monitor
		const updateStatusFromMonitor = (data: any) => {
			let statusText = '❓ Unknown';
			let statusClass = 'unknown';

			if (data.status === "Invalid API key") {
				statusText = 'Invalid API key';
				statusClass = 'stopped';
			} else if (data.status === "API key not set") {
				statusText = 'API key not set';
				statusClass = 'stopped';
			} else if (data.connectedDevicesCount === 0) {
				statusText = 'No devices connected';
				statusClass = 'stopped';
			} else if (data.status === "scanning") {
				statusText = 'Scanning';
				statusClass = 'running';
			} else if (data.fileCompletion !== undefined && data.fileCompletion < 100) {
				statusText = `Syncing (${data.fileCompletion.toFixed(1)}%)`;
				statusClass = 'running';
			} else if (data.connectedDevicesCount > 0) {
				statusText = 'Connected';
				statusClass = 'running';
			}

			// Update status indicator
			statusIndicator.className = `syncthing-status-indicator ${statusClass}`;
			statusIndicator.textContent = statusText;

			// Update devices info
			if (data.availableDevices !== undefined && data.connectedDevicesCount !== undefined) {
				devicesValue.textContent = `${data.connectedDevicesCount}/${data.availableDevices}`;
			}

			// Update sync progress
			if (data.fileCompletion !== undefined && !isNaN(data.fileCompletion)) {
				syncValue.textContent = `${data.fileCompletion.toFixed(1)}%`;
			} else if (data.status === "scanning") {
				syncValue.textContent = 'Scanning...';
			} else if (data.connectedDevicesCount > 0) {
				syncValue.textContent = 'Up to date';
			} else {
				syncValue.textContent = 'Unknown';
			}
		};

		// Remove any existing listeners to prevent duplicates
		this.plugin.monitor.off('status-update', updateStatusFromMonitor);
		// Add the new listener
		this.plugin.monitor.on('status-update', updateStatusFromMonitor);

		// Update status immediately
		this.updateStatus();
	}

	private renderConfigurationTab(container: HTMLElement): void {
		// API Configuration Section
		const apiSection = container.createDiv('syncthing-section');
		apiSection.createEl('h3', { cls: 'syncthing-section-title', text: '🔗 API Configuration' });
		apiSection.createDiv({
			cls: 'syncthing-section-description',
			text: 'Configure connection to Syncthing API. Find these settings in Syncthing GUI → Actions → Settings.'
		});

		const apiKeyGroup = apiSection.createDiv('syncthing-form-group');
		apiKeyGroup.createEl('label', { cls: 'syncthing-label', text: 'API Key' });
		const apiKeyInput = apiKeyGroup.createEl('input', {
			cls: 'syncthing-input',
			attr: { type: 'password', value: this.plugin.settings.syncthingApiKey, placeholder: 'Enter Syncthing API key' }
		});
		apiKeyGroup.createDiv({
			cls: 'syncthing-help-text',
			text: 'API key for authentication (found in Syncthing GUI → Settings → GUI)'
		});

		const folderIdGroup = apiSection.createDiv('syncthing-form-group');
		folderIdGroup.createEl('label', { cls: 'syncthing-label', text: 'Vault Folder ID' });
		const folderIdInput = folderIdGroup.createEl('input', {
			cls: 'syncthing-input',
			attr: { type: 'text', value: this.plugin.settings.vaultFolderID, placeholder: 'Enter vault folder ID' }
		});
		folderIdGroup.createDiv({
			cls: 'syncthing-help-text',
			text: 'ID of the folder containing your vault (found in Syncthing GUI → Folders)'
		});

		// Connection Mode Section
		const modeSection = container.createDiv('syncthing-section');
		modeSection.createEl('h3', { cls: 'syncthing-section-title', text: '📱 Connection Mode' });
		modeSection.createDiv({
			cls: 'syncthing-section-description',
			text: 'Choose how to connect to Syncthing: run locally, connect to remote instance, or use Docker.'
		});

		const mobileGroup = modeSection.createDiv('syncthing-form-group');
		const mobileCheckbox = mobileGroup.createEl('label', { cls: 'syncthing-checkbox' });
		const mobileInput = mobileCheckbox.createEl('input', { attr: { type: 'checkbox' } });
		mobileInput.checked = this.plugin.settings.mobileMode;
		mobileCheckbox.createSpan({ text: 'Mobile Mode (connect to remote Syncthing)' });

		const dockerGroup = modeSection.createDiv('syncthing-form-group');
		const dockerCheckbox = dockerGroup.createEl('label', { cls: 'syncthing-checkbox' });
		const dockerInput = dockerCheckbox.createEl('input', { attr: { type: 'checkbox' } });
		dockerInput.checked = this.plugin.settings.useDocker;
		dockerCheckbox.createSpan({ text: 'Use Docker (run Syncthing in container)' });

		const remoteUrlGroup = modeSection.createDiv('syncthing-form-group');
		remoteUrlGroup.createEl('label', { cls: 'syncthing-label', text: 'Remote Syncthing URL' });
		const remoteUrlInput = remoteUrlGroup.createEl('input', {
			cls: 'syncthing-input',
			attr: { type: 'text', value: this.plugin.settings.remoteUrl, placeholder: 'http://192.168.1.100:8384' }
		});
		remoteUrlGroup.createDiv({
			cls: 'syncthing-help-text',
			text: 'URL of remote Syncthing instance (used in mobile mode)'
		});

		// Startup Configuration Section
		const startupSection = container.createDiv('syncthing-section');
		startupSection.createEl('h3', { cls: 'syncthing-section-title', text: '🚀 Startup Configuration' });
		startupSection.createDiv({
			cls: 'syncthing-section-description',
			text: 'Control when Syncthing starts and stops with Obsidian.'
		});

		const autoStartGroup = startupSection.createDiv('syncthing-form-group');
		const autoStartCheckbox = autoStartGroup.createEl('label', { cls: 'syncthing-checkbox' });
		const autoStartInput = autoStartCheckbox.createEl('input', { attr: { type: 'checkbox' } });
		autoStartInput.checked = this.plugin.settings.startOnObsidianOpen;
		autoStartCheckbox.createSpan({ text: 'Start Syncthing when Obsidian opens' });

		const autoStopGroup = startupSection.createDiv('syncthing-form-group');
		const autoStopCheckbox = autoStopGroup.createEl('label', { cls: 'syncthing-checkbox' });
		const autoStopInput = autoStopCheckbox.createEl('input', { attr: { type: 'checkbox' } });
		autoStopInput.checked = this.plugin.settings.stopOnObsidianClose;
		autoStopCheckbox.createSpan({ text: 'Stop Syncthing when Obsidian closes' });

		// Save button
		const saveBtn = container.createEl('button', {
			cls: 'syncthing-btn primary',
			text: '💾 Save Configuration'
		});
		saveBtn.addEventListener('click', async () => {
			this.plugin.settings.syncthingApiKey = apiKeyInput.value;
			this.plugin.settings.vaultFolderID = folderIdInput.value;
			this.plugin.settings.mobileMode = mobileInput.checked;
			this.plugin.settings.useDocker = dockerInput.checked;
			this.plugin.settings.remoteUrl = remoteUrlInput.value;
			this.plugin.settings.startOnObsidianOpen = autoStartInput.checked;
			this.plugin.settings.stopOnObsidianClose = autoStopInput.checked;

			await this.plugin.saveSettings();
			new Notice('Settings saved successfully');
		});
	}

	private renderAdvancedTab(container: HTMLElement): void {
		// Binary Management Section
		const binarySection = container.createDiv('syncthing-section');
		binarySection.createEl('h3', { cls: 'syncthing-section-title', text: '📦 Binary Management' });
		binarySection.createDiv({
			cls: 'syncthing-section-description',
			text: 'Download, verify, and manage the Syncthing executable.'
		});

		const binaryDiagnostic = binarySection.createDiv('syncthing-diagnostic');
		binaryDiagnostic.createDiv({ cls: 'syncthing-diagnostic-title', text: 'Executable Status' });
		
		const pathItem = binaryDiagnostic.createDiv('syncthing-diagnostic-item');
		pathItem.createSpan({ cls: 'syncthing-diagnostic-label', text: 'Path:' });
		pathItem.createSpan({ 
			cls: 'syncthing-diagnostic-value', 
			text: this.plugin.getSyncthingExecutablePath()
		});

		const statusItem = binaryDiagnostic.createDiv('syncthing-diagnostic-item');
		statusItem.createSpan({ cls: 'syncthing-diagnostic-label', text: 'Status:' });
		const statusValue = statusItem.createSpan({ cls: 'syncthing-diagnostic-value' });
		
		// Check executable status
		this.plugin.checkExecutableExists().then(exists => {
			statusValue.textContent = exists ? 'Found' : 'Not found';
		});

		const binaryControls = binarySection.createDiv('syncthing-controls');
		
		const downloadBtn = binaryControls.createEl('button', {
			cls: 'syncthing-btn primary',
			text: '⬇️ Download'
		});
		downloadBtn.addEventListener('click', async () => {
			downloadBtn.disabled = true;
			downloadBtn.textContent = '⏳ Downloading...';
			try {
				const success = await this.plugin.downloadSyncthingExecutable();
				if (success) {
					new Notice('✅ Syncthing downloaded successfully');
					this.renderAdvancedTab(container);
				} else {
					new Notice('❌ Download failed');
				}
			} catch (error) {
				new Notice(`Download failed: ${error.message}`);
			} finally {
				downloadBtn.disabled = false;
				downloadBtn.textContent = '⬇️ Download';
			}
		});

		const redownloadBtn = binaryControls.createEl('button', {
			cls: 'syncthing-btn secondary',
			text: '🔄 Re-download'
		});
		redownloadBtn.addEventListener('click', async () => {
			redownloadBtn.disabled = true;
			redownloadBtn.textContent = '⏳ Re-downloading...';
			try {
				// Remove existing executable
				const executablePath = this.plugin.getSyncthingExecutablePath();
				if (typeof require !== 'undefined') {
					const fs = require('fs');
					const path = require('path');
					
					try {
						const syncthingDir = path.dirname(executablePath);
						if (fs.existsSync(syncthingDir)) {
							fs.rmSync(syncthingDir, { recursive: true, force: true });
						}
					} catch (removeError) {
						console.log('Could not remove existing executable:', removeError);
					}
				}
				
				const success = await this.plugin.downloadSyncthingExecutable();
				if (success) {
					new Notice('✅ Syncthing re-downloaded successfully');
					this.renderAdvancedTab(container);
				} else {
					new Notice('❌ Re-download failed');
				}
			} catch (error) {
				new Notice(`Re-download failed: ${error.message}`);
			} finally {
				redownloadBtn.disabled = false;
				redownloadBtn.textContent = '🔄 Re-download';
			}
		});

		const checkBtn = binaryControls.createEl('button', {
			cls: 'syncthing-btn secondary',
			text: '✅ Check'
		});
		checkBtn.addEventListener('click', async () => {
			const exists = await this.plugin.checkExecutableExists();
			if (exists) {
				new Notice('✅ Syncthing executable found and accessible');
			} else {
				new Notice('❌ Syncthing executable not found');
			}
		});

		// Control Actions Section
		const controlSection = container.createDiv('syncthing-section');
		controlSection.createEl('h3', { cls: 'syncthing-section-title', text: '🎛️ Control Actions' });
		
		const controlActions = controlSection.createDiv('syncthing-controls');
		
		const pauseBtn = controlActions.createEl('button', {
			cls: 'syncthing-btn secondary',
			text: '⏸️ Pause Sync'
		});
		pauseBtn.addEventListener('click', async () => {
			try {
				const success = await this.plugin.pauseSyncthing();
				if (success) {
					new Notice('Syncthing paused successfully');
				} else {
					new Notice('Failed to pause Syncthing');
				}
			} catch (error) {
				new Notice(`Failed to pause Syncthing: ${error.message}`);
			}
		});

		const resumeBtn = controlActions.createEl('button', {
			cls: 'syncthing-btn success',
			text: '▶️ Resume Sync'
		});
		resumeBtn.addEventListener('click', async () => {
			try {
				const success = await this.plugin.resumeSyncthing();
				if (success) {
					new Notice('Syncthing resumed successfully');
				} else {
					new Notice('Failed to resume Syncthing');
				}
			} catch (error) {
				new Notice(`Failed to resume Syncthing: ${error.message}`);
			}
		});

		const resetBtn = controlActions.createEl('button', {
			cls: 'syncthing-btn danger',
			text: '🔄 Reset Config'
		});
		resetBtn.addEventListener('click', async () => {
			try {
				await this.plugin.stopSyncthing();
				await new Promise(resolve => setTimeout(resolve, 1000));
				
				if (typeof require !== 'undefined') {
					const fs = require('fs');
					const path = require('path');
					const configDir = `${this.plugin.getPluginAbsolutePath()}syncthing-config`;
					
					if (fs.existsSync(configDir)) {
						fs.rmSync(configDir, { recursive: true, force: true });
						new Notice('Syncthing configuration reset successfully');
					} else {
						new Notice('No configuration found to reset');
					}
				}
			} catch (error) {
				new Notice(`Failed to reset configuration: ${error.message}`);
			}
		});

		// Diagnostics Section
		const diagnosticsSection = container.createDiv('syncthing-section');
		diagnosticsSection.createEl('h3', { cls: 'syncthing-section-title', text: '🔍 System Diagnostics' });
		
		const diagnostics = diagnosticsSection.createDiv('syncthing-diagnostic');
		diagnostics.createDiv({ cls: 'syncthing-diagnostic-title', text: 'System Information' });

		const platformItem = diagnostics.createDiv('syncthing-diagnostic-item');
		platformItem.createSpan({ cls: 'syncthing-diagnostic-label', text: 'Platform:' });
		platformItem.createSpan({ cls: 'syncthing-diagnostic-value', text: `${process.platform} ${process.arch}` });

		const nodeItem = diagnostics.createDiv('syncthing-diagnostic-item');
		nodeItem.createSpan({ cls: 'syncthing-diagnostic-label', text: 'Node.js:' });
		nodeItem.createSpan({ cls: 'syncthing-diagnostic-value', text: process.version });

		const pluginItem = diagnostics.createDiv('syncthing-diagnostic-item');
		pluginItem.createSpan({ cls: 'syncthing-diagnostic-label', text: 'Plugin Version:' });
		pluginItem.createSpan({ cls: 'syncthing-diagnostic-value', text: '1.5.1' });

		// Debug Actions
		const debugControls = diagnosticsSection.createDiv('syncthing-controls');
		
		const logsBtn = debugControls.createEl('button', {
			cls: 'syncthing-btn secondary',
			text: '📋 View Logs'
		});
		logsBtn.addEventListener('click', () => {
			console.log('Syncthing Plugin Debug Info:', {
				settings: this.plugin.settings,
				executablePath: this.plugin.getSyncthingExecutablePath(),
				platform: process.platform,
				arch: process.arch
			});
			new Notice('Debug info logged to console (F12)');
		});

		const testBtn = debugControls.createEl('button', {
			cls: 'syncthing-btn secondary',
			text: '🧪 Test Connection'
		});
		testBtn.addEventListener('click', async () => {
			try {
				const isRunning = await this.plugin.isSyncthingRunning();
				if (isRunning) {
					new Notice('✅ Connection successful - Syncthing is running');
				} else {
					new Notice('❌ Connection failed - Syncthing not running');
				}
			} catch (error) {
				new Notice(`❌ Connection test failed: ${error.message}`);
			}
		});
	}

	private renderAboutTab(container: HTMLElement): void {
		const aboutEl = container.createDiv('syncthing-about');
		
		aboutEl.createDiv({ cls: 'syncthing-logo', text: '🔄' });
		aboutEl.createEl('h2', { cls: 'syncthing-about-title', text: 'Syncthing Launcher' });
		aboutEl.createDiv({ 
			cls: 'syncthing-about-version', 
			text: 'Version 1.5.1' 
		});
		
		aboutEl.createDiv({
			cls: 'syncthing-about-description',
			text: 'This plugin provides seamless integration between Obsidian and Syncthing, enabling you to automatically sync your vault across devices with Syncthing\'s peer-to-peer file synchronization.'
		});

		const linksEl = aboutEl.createDiv('syncthing-links');
		
		const githubLink = linksEl.createEl('a', {
			cls: 'syncthing-link',
			text: '📚 GitHub Repository',
			href: '#'
		});
		githubLink.addEventListener('click', (e) => {
			e.preventDefault();
			window.open('https://github.com/LBF38/obsidian-syncthing-integration', '_blank');
		});

		const syncthingLink = linksEl.createEl('a', {
			cls: 'syncthing-link',
			text: '🌐 Syncthing.net',
			href: '#'
		});
		syncthingLink.addEventListener('click', (e) => {
			e.preventDefault();
			window.open('https://syncthing.net', '_blank');
		});

		const docsLink = linksEl.createEl('a', {
			cls: 'syncthing-link',
			text: '📖 Documentation',
			href: '#'
		});
		docsLink.addEventListener('click', (e) => {
			e.preventDefault();
			window.open('https://docs.syncthing.net', '_blank');
		});

		// Feature highlights
		const featuresSection = container.createDiv('syncthing-section');
		featuresSection.createEl('h3', { cls: 'syncthing-section-title', text: '✨ Features' });
		
		const featuresList = featuresSection.createEl('ul');
		const features = [
			'Automatic Syncthing download and installation',
			'Cross-platform support (Windows, macOS, Linux)',
			'Configurable auto-start with Obsidian',
			'Web UI integration for advanced configuration', 
			'Real-time status monitoring',
			'Mobile mode for remote connections',
			'Docker support for containerized deployment'
		];

		features.forEach(feature => {
			featuresList.createEl('li', { text: feature });
		});
	}

	private async updateStatus(): Promise<void> {
		try {
			const isRunning = await this.plugin.isSyncthingRunning();
			this.updateStatusDisplay(isRunning ? 'running' : 'stopped');
		} catch (error) {
			this.updateStatusDisplay('unknown');
		}
	}

	private updateStatusDisplay(status: 'running' | 'stopped' | 'unknown'): void {
		const indicator = this.containerEl.querySelector('.syncthing-status-indicator');
		
		if (indicator) {
			indicator.className = `syncthing-status-indicator ${status}`;
			indicator.textContent = status === 'running' ? 'Running' : status === 'stopped' ? 'Stopped' : 'Unknown';
		}
	}

	private startAutoRefresh(): void {
		this.stopAutoRefresh();
		this.refreshInterval = setInterval(() => {
			if (this.activeTab === 'overview') {
				this.updateStatus();
			}
		}, 10000); // Refresh every 10 seconds
	}

	private stopAutoRefresh(): void {
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
	}

	hide(): void {
		this.stopAutoRefresh();
		super.hide();
	}
}
