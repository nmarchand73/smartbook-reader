const BACKUP_VERSION = 1;
const STORAGE_PREFIX = 'sbr_';
const API_KEY_STORAGE_KEY = 'sbr_anthropic_api_key';

export interface LocalDataBackup {
  app: 'smartbook-reader';
  version: number;
  exportedAt: string;
  includesApiKey: boolean;
  localStorage: Record<string, string>;
}

export interface ImportLocalDataResult {
  importedCount: number;
  skippedCount: number;
  includedApiKey: boolean;
}

function isAllowedStorageKey(key: string, includeApiKey: boolean): boolean {
  if (!key.startsWith(STORAGE_PREFIX)) return false;
  if (!includeApiKey && key === API_KEY_STORAGE_KEY) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exportLocalData(includeApiKey: boolean): LocalDataBackup {
  const data: Record<string, string> = {};

  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key || !isAllowedStorageKey(key, includeApiKey)) continue;

    const value = localStorage.getItem(key);
    if (typeof value === 'string') data[key] = value;
  }

  return {
    app: 'smartbook-reader',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    includesApiKey: includeApiKey && API_KEY_STORAGE_KEY in data,
    localStorage: data,
  };
}

export function downloadLocalDataBackup(includeApiKey: boolean): void {
  const backup = exportLocalData(includeApiKey);
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);

  anchor.href = url;
  anchor.download = `smartbook-reader-backup-${date}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function readBackupFile(file: File): Promise<LocalDataBackup> {
  const raw = await file.text();
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('Fichier de sauvegarde invalide.');
  }

  if (parsed.app !== 'smartbook-reader') {
    throw new Error('Ce fichier ne semble pas être une sauvegarde SmartBook Reader.');
  }

  if (parsed.version !== BACKUP_VERSION) {
    throw new Error('Version de sauvegarde non prise en charge.');
  }

  if (!isRecord(parsed.localStorage)) {
    throw new Error('Données de sauvegarde manquantes.');
  }

  const localStorageData: Record<string, string> = {};
  Object.entries(parsed.localStorage).forEach(([key, value]) => {
    if (typeof value === 'string') localStorageData[key] = value;
  });

  return {
    app: 'smartbook-reader',
    version: BACKUP_VERSION,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    includesApiKey: parsed.includesApiKey === true,
    localStorage: localStorageData,
  };
}

export function importLocalData(
  backup: LocalDataBackup,
  options: { includeApiKey: boolean }
): ImportLocalDataResult {
  let importedCount = 0;
  let skippedCount = 0;
  let includedApiKey = false;

  Object.entries(backup.localStorage).forEach(([key, value]) => {
    if (!isAllowedStorageKey(key, options.includeApiKey)) {
      skippedCount += 1;
      return;
    }

    localStorage.setItem(key, value);
    importedCount += 1;
    if (key === API_KEY_STORAGE_KEY) includedApiKey = true;
  });

  return {
    importedCount,
    skippedCount,
    includedApiKey,
  };
}
