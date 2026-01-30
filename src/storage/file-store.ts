import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export interface StoreOptions {
  basePath: string;
  enableBackup?: boolean;
  maxBackups?: number;
}

// Simple file locking mechanism
const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const normalizedPath = path.normalize(filePath);
  
  // Wait for any existing lock
  while (fileLocks.has(normalizedPath)) {
    await fileLocks.get(normalizedPath);
  }
  
  // Create new lock
  let releaseLock: () => void;
  const lockPromise = new Promise<void>(resolve => {
    releaseLock = resolve;
  });
  fileLocks.set(normalizedPath, lockPromise);
  
  try {
    return await fn();
  } finally {
    fileLocks.delete(normalizedPath);
    releaseLock!();
  }
}

export class FileStore {
  private basePath: string;
  private enableBackup: boolean;
  private maxBackups: number;

  constructor(options: StoreOptions) {
    this.basePath = options.basePath;
    this.enableBackup = options.enableBackup ?? true;
    this.maxBackups = options.maxBackups ?? 3;
    this.ensureDirSync(this.basePath);
  }

  private ensureDirSync(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private async ensureDir(dirPath: string): Promise<void> {
    try {
      await fsp.access(dirPath);
    } catch {
      await fsp.mkdir(dirPath, { recursive: true });
    }
  }

  private getFilePath(filename: string): string {
    return path.join(this.basePath, filename);
  }

  private async createBackup(filePath: string): Promise<void> {
    if (!this.enableBackup) return;
    
    try {
      await fsp.access(filePath);
      const timestamp = Date.now();
      const backupPath = `${filePath}.${timestamp}.bak`;
      await fsp.copyFile(filePath, backupPath);
      
      // Cleanup old backups
      const dir = path.dirname(filePath);
      const basename = path.basename(filePath);
      const files = await fsp.readdir(dir);
      const backups = files
        .filter(f => f.startsWith(basename) && f.endsWith('.bak'))
        .sort()
        .reverse();
      
      // Remove excess backups
      for (let i = this.maxBackups; i < backups.length; i++) {
        await fsp.unlink(path.join(dir, backups[i])).catch(() => {});
      }
    } catch {
      // File doesn't exist, no backup needed
    }
  }

  async read<T>(filename: string, defaultValue: T): Promise<T> {
    const filePath = this.getFilePath(filename);
    return withFileLock(filePath, async () => {
      try {
        const content = await fsp.readFile(filePath, 'utf-8');
        return JSON.parse(content) as T;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return defaultValue;
        }
        // Log and throw for non-ENOENT errors (don't swallow)
        console.error(`[FileStore] Error reading ${filename}:`, err.message);
        throw new Error(`Failed to read ${filename}: ${err.message}`);
      }
    });
  }

  async write<T>(filename: string, data: T): Promise<void> {
    const filePath = this.getFilePath(filename);
    return withFileLock(filePath, async () => {
      const dir = path.dirname(filePath);
      await this.ensureDir(dir);
      
      // Create backup before write
      await this.createBackup(filePath);
      
      // Write to temp file first, then rename (atomic write)
      const tempPath = `${filePath}.tmp.${Date.now()}`;
      const content = JSON.stringify(data, null, 2);
      try {
        await fsp.writeFile(tempPath, content, 'utf-8');
        await fsp.rename(tempPath, filePath);
      } catch (error) {
        // Cleanup temp file on failure
        await fsp.unlink(tempPath).catch(() => {});
        throw error;
      }
    });
  }

  async append<T>(filename: string, item: T): Promise<void> {
    const filePath = this.getFilePath(filename);
    return withFileLock(filePath, async () => {
      let existing: T[];
      try {
        const content = await fsp.readFile(filePath, 'utf-8');
        existing = JSON.parse(content) as T[];
      } catch {
        existing = [];
      }
      existing.push(item);
      
      const dir = path.dirname(filePath);
      await this.ensureDir(dir);
      await this.createBackup(filePath);
      
      const tempPath = `${filePath}.tmp.${Date.now()}`;
      const content = JSON.stringify(existing, null, 2);
      try {
        await fsp.writeFile(tempPath, content, 'utf-8');
        await fsp.rename(tempPath, filePath);
      } catch (error) {
        await fsp.unlink(tempPath).catch(() => {});
        throw error;
      }
    });
  }

  async delete(filename: string): Promise<boolean> {
    const filePath = this.getFilePath(filename);
    return withFileLock(filePath, async () => {
      try {
        await fsp.unlink(filePath);
        return true;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return false;
        }
        console.error(`[FileStore] Error deleting ${filename}:`, err.message);
        throw new Error(`Failed to delete ${filename}: ${err.message}`);
      }
    });
  }

  async exists(filename: string): Promise<boolean> {
    try {
      await fsp.access(this.getFilePath(filename));
      return true;
    } catch {
      return false;
    }
  }

  async list(subdir?: string): Promise<string[]> {
    const dirPath = subdir ? path.join(this.basePath, subdir) : this.basePath;
    await this.ensureDir(dirPath);
    try {
      const files = await fsp.readdir(dirPath);
      return files.filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  getSubStore(subdir: string): FileStore {
    return new FileStore({
      basePath: path.join(this.basePath, subdir),
      enableBackup: this.enableBackup,
      maxBackups: this.maxBackups
    });
  }
}

let storeInstance: FileStore | null = null;

export function getStore(basePath?: string): FileStore {
  if (!storeInstance) {
    const defaultPath = path.join(process.cwd(), '.context');
    storeInstance = new FileStore({ basePath: basePath || defaultPath });
  }
  return storeInstance;
}

export function initStore(basePath: string, options?: Partial<StoreOptions>): FileStore {
  storeInstance = new FileStore({ 
    basePath, 
    ...options 
  });
  return storeInstance;
}
