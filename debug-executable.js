#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

// Test the downloaded Syncthing executable thoroughly
async function testSyncthingExecutable() {
    const executablePath = '/Volumes/My Files/Obsidian/muxammadreza/.obsidian/plugins/obsidian-syncthing-launcher-1.4.2/syncthing/syncthing-macos';
    
    console.log('=== Comprehensive Syncthing Executable Test ===');
    console.log(`Testing: ${executablePath}`);
    console.log('');
    
    // 1. Check if file exists
    if (!fs.existsSync(executablePath)) {
        console.log('❌ File does not exist');
        return false;
    }
    console.log('✅ File exists');
    
    // 2. Get file info
    const stats = fs.statSync(executablePath);
    console.log(`File size: ${stats.size} bytes`);
    console.log(`File permissions: ${(stats.mode & parseInt('777', 8)).toString(8)}`);
    
    // 3. Check file type
    try {
        const fileOutput = await new Promise((resolve, reject) => {
            exec(`file "${executablePath}"`, (error, stdout, stderr) => {
                if (error) reject(error);
                else resolve(stdout.trim());
            });
        });
        console.log(`File type: ${fileOutput}`);
    } catch (error) {
        console.log(`❌ Could not determine file type: ${error.message}`);
    }
    
    // 4. Check architecture compatibility
    try {
        const archOutput = await new Promise((resolve, reject) => {
            exec(`lipo -info "${executablePath}" 2>/dev/null || otool -hv "${executablePath}" 2>/dev/null || echo "Not a Mach-O binary"`, (error, stdout, stderr) => {
                resolve(stdout.trim() || stderr.trim() || 'Unknown architecture');
            });
        });
        console.log(`Architecture info: ${archOutput}`);
    } catch (error) {
        console.log(`❌ Could not check architecture: ${error.message}`);
    }
    
    // 5. Check if it's a valid executable
    try {
        fs.accessSync(executablePath, fs.constants.F_OK | fs.constants.X_OK);
        console.log('✅ File has execute permissions');
    } catch (error) {
        console.log('❌ File does not have execute permissions:', error.message);
        return false;
    }
    
    // 6. Try to read first few bytes to check if it's a valid binary
    try {
        const buffer = fs.readFileSync(executablePath, { start: 0, end: 16 });
        const magic = buffer.toString('hex');
        console.log(`File magic bytes: ${magic}`);
        
        // Check for common executable signatures
        if (magic.startsWith('cafebabe') || magic.startsWith('feedface') || magic.startsWith('cffaedfe')) {
            console.log('✅ Appears to be a valid Mach-O binary');
        } else if (magic.startsWith('7f454c46')) {
            console.log('⚠️  Appears to be an ELF binary (Linux) - wrong platform!');
        } else {
            console.log('⚠️  Unknown binary format');
        }
    } catch (error) {
        console.log(`❌ Could not read file header: ${error.message}`);
    }
    
    // 7. Try direct execution with --version
    console.log('');
    console.log('=== Testing Direct Execution ===');
    try {
        const versionOutput = await new Promise((resolve, reject) => {
            exec(`"${executablePath}" --version`, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
                }
            });
        });
        console.log('✅ Direct execution successful');
        console.log(`Version output: ${versionOutput.stdout}`);
        if (versionOutput.stderr) {
            console.log(`Stderr: ${versionOutput.stderr}`);
        }
    } catch (error) {
        console.log('❌ Direct execution failed:', error.message);
        console.log('This explains why spawn() is also failing');
        
        // Try to get more details about the error
        if (error.code) {
            console.log(`Error code: ${error.code}`);
        }
        if (error.signal) {
            console.log(`Signal: ${error.signal}`);
        }
        return false;
    }
    
    // 8. Try spawn test (similar to what the plugin does)
    console.log('');
    console.log('=== Testing Node.js spawn() ===');
    try {
        await new Promise((resolve, reject) => {
            const child = spawn(executablePath, ['--version'], { timeout: 10000 });
            let stdout = '';
            let stderr = '';
            
            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            child.on('close', (code) => {
                if (code === 0) {
                    console.log('✅ spawn() test successful');
                    console.log(`Output: ${stdout.trim()}`);
                    resolve();
                } else {
                    reject(new Error(`Process exited with code ${code}, stderr: ${stderr}`));
                }
            });
            
            child.on('error', (error) => {
                reject(error);
            });
        });
    } catch (error) {
        console.log('❌ spawn() test failed:', error.message);
        console.log('This matches the plugin error');
        return false;
    }
    
    console.log('');
    console.log('=== Test Complete ===');
    return true;
}

// Run the test
testSyncthingExecutable().then(success => {
    console.log(`Overall result: ${success ? 'PASSED' : 'FAILED'}`);
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('Test error:', error);
    process.exit(1);
});
