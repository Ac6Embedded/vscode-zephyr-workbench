import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
// import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

// Simple test to verify the generateEnvVarsCommands function for pwsh
// from debugUtils.ts and line 263
function generateEnvVarsCommands(envVars: Record<string, any>, shell: string): string {
    let envVarsCommands = '';
    for (const [key, value] of Object.entries(envVars)) {
        if(key === null || key === undefined || value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
            continue;
        }
        switch (shell) {
            case 'bash': 
                envVarsCommands += `export ${key}="${value}"\n`;
                break;
            case 'cmd.exe':
                envVarsCommands += `set ${key}=${value}\n`;
                break;
            case 'powershell.exe':
				envVarsCommands += `$env:${key} = "${value}"\n`;
				break;
            case 'pwsh.exe':
                envVarsCommands += `$env:${key} = "${value}"\n`;
                break; 
            default:
                envVarsCommands += `export ${key}="${value}"\n`;
                break;
        }
    }
    return envVarsCommands;
}

// Function to create a PowerShell 7 wrapper script
// from debugUtils.ts and line 316
function createPowershellWrapper(buildDir: string, envVarsCommands: string, debugServerCommand: string) {
    const wrapperScript = `${envVarsCommands}

# Source environment and execute West
${debugServerCommand}
`;
    const wrapperPath = path.join(buildDir, 'west_wrapper.ps1');
    fs.writeFileSync(wrapperPath, wrapperScript);
    return { wrapperPath, wrapperScript };
}



describe('Extension Test Suite', () => {
    it('Sample test', () => {
        assert.strictEqual(-1, [1, 2, 3].indexOf(5));
        assert.strictEqual(-1, [1, 2, 3].indexOf(0));
    });

    it('pwsh env var command generation', () => {
        const envVars = { FOO: 'bar', BAZ: 123 };
        const shell = 'pwsh.exe';
        const result = generateEnvVarsCommands(envVars, shell);
        assert.strictEqual(result, `$env:FOO = "bar"\n$env:BAZ = "123"\n`);
    });
    it('should create a correct west_wrapper.ps1 file', () => {
        const buildDir = './test-tmp';
		// Cleanup previous test run
        if (fs.existsSync(buildDir)) {
			fs.readdirSync(buildDir).forEach(f => fs.unlinkSync(path.join(buildDir, f)));
			fs.rmdirSync(buildDir);
		}
		fs.mkdirSync(buildDir);

        const envVarsCommands = `$env:FOO = "bar"\n$env:BAZ = "123"`;
        const debugServerCommand = 'west $args';
        const { wrapperPath, wrapperScript } = createPowershellWrapper(buildDir, envVarsCommands, debugServerCommand);

        // check if file exists
        assert.ok(fs.existsSync(wrapperPath));

        // check the content of the file
        const fileContent = fs.readFileSync(wrapperPath, 'utf-8');
        assert.strictEqual(fileContent, `${envVarsCommands}\n\n# Source environment and execute West\n${debugServerCommand}\n`);

        // Cleanup again
        fs.unlinkSync(wrapperPath);
        fs.rmdirSync(buildDir);
    });
});