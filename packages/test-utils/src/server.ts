import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendTestEnv, testDatabaseUrl } from './env.js';

/**
 * Boots the real Express backend as a child process (tsx) on a free port and
 * waits for /v1/health. Child-process boot (rather than importing the app)
 * exercises the real boot path — including fail-fast env validation — and keeps
 * the backend's module state fully isolated per test file.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** apps/backend — valid from both src/ and dist/. */
const BACKEND_DIR = path.resolve(__dirname, '../../../apps/backend');

export interface BootedServer {
	/** e.g. http://127.0.0.1:51234 — no path prefix. */
	baseUrl: string;
	port: number;
	/** Combined child stdout+stderr captured so far (surfaced on boot failure). */
	logs: () => string;
	/** SIGTERM → wait → SIGKILL escalation. Safe to call twice. */
	stop: () => Promise<void>;
}

export interface BootOptions {
	/** Extra/override env vars merged over backendTestEnv(). */
	env?: Record<string, string>;
	/** Boot timeout waiting for the health check (default 60s). */
	timeoutMs?: number;
	/** Fixed port to listen on (default: a free port is allocated). Useful for e2e wiring. */
	port?: number;
}

/** Find a free TCP port by binding port 0. */
export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const address = srv.address();
			if (address === null || typeof address === 'object') {
				const port = (address as net.AddressInfo).port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error('Could not allocate a free port')));
			}
		});
	});
}

async function waitForHealth(baseUrl: string, timeoutMs: number, isDead: () => boolean, logs: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError = '';
	while (Date.now() < deadline) {
		if (isDead()) {
			throw new Error(`Backend process exited before becoming healthy.\n${logs()}`);
		}
		try {
			const res = await fetch(`${baseUrl}/v1/health`);
			if (res.ok) return;
			lastError = `HTTP ${res.status}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(
		`Backend did not become healthy within ${timeoutMs}ms (last: ${lastError}).\n${logs()}`,
	);
}

function killChild(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		const force = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		}, 5000);
		force.unref();
		child.once('exit', () => {
			clearTimeout(force);
			resolve();
		});
		child.kill('SIGTERM');
	});
}

/**
 * Boot the backend against the test database with throwaway state dirs.
 * The caller is responsible for `ensureTestDatabase()` beforehand and `stop()` after.
 */
export async function bootBackend(options: BootOptions = {}): Promise<BootedServer> {
	const port = options.port ?? (await freePort());
	const baseUrl = `http://127.0.0.1:${port}`;
	const tmpRoot = await import('node:fs/promises').then((fs) =>
		fs.mkdtemp(path.join(os.tmpdir(), 'valmis-test-')),
	);

	const env: Record<string, string> = {
		...backendTestEnv({
			BACKEND_PORT: String(port),
			DATABASE_URL: testDatabaseUrl(),
			AGENT_WORKSPACES_PATH: path.join(tmpRoot, 'agent-workspaces'),
			CHAT_FILES_PATH: path.join(tmpRoot, 'chat-files'),
			APP_DATA_PATH: path.join(tmpRoot, 'app-data'),
		}),
		...(options.env ?? {}),
	};

	const child: ChildProcess = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
		cwd: BACKEND_DIR,
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let logBuffer = '';
	const append = (chunk: Buffer) => {
		logBuffer += chunk.toString();
		// Keep the last ~64 KB so a chatty boot can't grow memory unboundedly.
		if (logBuffer.length > 64 * 1024) logBuffer = logBuffer.slice(-64 * 1024);
	};
	child.stdout?.on('data', append);
	child.stderr?.on('data', append);

	let dead = false;
	child.once('exit', () => {
		dead = true;
	});

	const logs = () => logBuffer;
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await killChild(child);
	};

	try {
		await waitForHealth(baseUrl, options.timeoutMs ?? 60_000, () => dead, logs);
	} catch (err) {
		await stop();
		throw err;
	}

	return { baseUrl, port, logs, stop };
}
