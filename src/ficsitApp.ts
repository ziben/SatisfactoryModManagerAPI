import request from 'request-promise-native';
import { compare, satisfies } from 'semver';
import { versionSatisfiesAll, removeArrayElementWhere } from './utils';
import { ModNotFoundError } from './errors';
import { minSMLVersion, SMLModID } from './smlHandler';
import { BootstrapperModID } from './bootstrapperHandler';
import { warn, debug } from './logging';

const API_URL = 'https://api.ficsit.app';
const GRAPHQL_API_URL = `${API_URL}/v2/query`;

let useTempMods = false; // TODO: remove once more mods are updated so live data can be used for tests instead

/**
 * This function should be used for debugging purposes only!
 * @param enable if true enables temporary mods usage
 */
export function setUseTempMods(enable: boolean): void {
  useTempMods = enable;
  if (useTempMods) {
    warn('Enabling temporary mods. This feature should be used for debugging purposes only!');
  }
}

export function getUseTempMods(use: boolean): void {
  useTempMods = use;
}

const tempMods: Array<FicsitAppMod> = [];

export function addTempMod(mod: FicsitAppMod): void {
  if (useTempMods) {
    tempMods.push(mod);
  } else {
    warn('Temporary mods are only available in debug mode');
  }
}

export function addTempModVersion(version: FicsitAppVersion): void {
  if (useTempMods) {
    const tempMod = tempMods.find((mod) => mod.id === version.mod_id);
    if (tempMod) {
      tempMod.versions.push(version);
    }
  } else {
    warn('Temporary mods are only available in debug mode');
  }
}

export function removeTempMod(modID: string): void {
  if (useTempMods) {
    removeArrayElementWhere(tempMods, (mod) => mod.id === modID);
  } else {
    warn('Temporary mods are only available in debug mode');
  }
}

export function removeTempModVersion(modID: string, version: string): void {
  if (useTempMods) {
    const mod = tempMods.find((tempMod) => tempMod.id === modID);
    if (mod) {
      removeArrayElementWhere(mod.versions, (modVersion) => modVersion.version === version);
    }
  } else {
    warn('Temporary mods are only available in debug mode');
  }
}

export async function fiscitApiQuery(query: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  variables?: { [key: string]: any }): Promise<{ [key: string]: any }> {
  try {
    const response = JSON.parse(await request(GRAPHQL_API_URL, {
      method: 'POST',
      body: JSON.stringify({
        query,
        variables,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    }));
    return response.data;
  } catch (e) {
    debug(e);
    return { errors: new Error('Network error. Please try again later.') };
  }
}

interface FicsitAppFetch {
  time: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

const cachedFetch: { [requestID: string]: FicsitAppFetch } = {};
const fetchCooldown = 5 * 60 * 1000;

function cooldownPassed(action: string): boolean {
  return cachedFetch[action] ? Date.now() - cachedFetch[action].time > fetchCooldown : true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCache(action: string): any {
  return cachedFetch[action]?.data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setCache(action: string, data: any): void {
  cachedFetch[action] = {
    time: Date.now(),
    data,
  };
}


export interface FicsitAppMod {
  id: string;
  name: string;
  short_description: string;
  full_description: string;
  logo: string;
  source_url: string;
  views: number;
  downloads: number;
  hotness: number;
  popularity: number;
  last_version_date: Date;
  authors: Array<FicsitAppAuthor>;
  versions: Array<FicsitAppVersion>;
}

export interface FicsitAppVersion {
  mod_id: string;
  version: string;
  sml_version: string;
  changelog: string;
  downloads: string;
  stability: 'alpha' | 'beta' | 'release';
  link: string;
}

export interface FicsitAppAuthor {
  mod_id: string;
  user: FicsitAppUser;
  role: string;
}

export interface FicsitAppUser {
  username: string;
  avatar: string;
}

export async function getModDownloadLink(modID: string, version: string): Promise<string> {
  const requestID = `getModDownloadLink_${modID}_${version}`;
  if (cooldownPassed(requestID)) {
    const res = await fiscitApiQuery(`
    query($modID: ModID!, $version: String!){
      getMod(modId: $modID)
      {
        version(version: $version)
        {
          link
        }
      }
    }
    `, { modID, version });
    if (res.errors) {
      throw res.errors;
    } else if (res.getMod && res.getMod.version) {
      setCache(requestID, API_URL + res.getMod.version.link);
    } else if (tempMods.some((mod) => mod.id === modID)) {
      throw new ModNotFoundError(`${modID}@${version} is a temporary mod. No download link available`);
    } else {
      throw new ModNotFoundError(`${modID}@${version} not found`);
    }
  }
  return getCache(requestID);
}

export async function getAvailableMods(): Promise<Array<FicsitAppMod>> {
  const requestID = 'getAvailableMods';
  if (cooldownPassed(requestID)) {
    const res = await fiscitApiQuery(`
    {
      getMods(filter: {
        limit: 100
      })
      {
        mods
        {
          name,
          short_description,
          full_description,
          id,
          logo,
          views,
          downloads,
          hotness,
          popularity,
          last_version_date,
          authors
          {
            mod_id,
            user
            {
              username,
              avatar
            },
            role
          },
          versions
          {
            mod_id,
            version,
            sml_version,
            changelog,
            downloads,
            stability,
            link
          }
        }
      }
    }
    `);
    if (res.errors) {
      throw res.errors;
    } else {
      const resGetMods = res.getMods.mods;
      for (let i = 0; i < resGetMods.length; i += 1) {
        resGetMods[i].last_version_date = resGetMods[i].last_version_date ? new Date(resGetMods[i].last_version_date) : null;
      }
      if (useTempMods) {
        resGetMods.push(...tempMods);
      }
      setCache(requestID, resGetMods);
    }
  }
  return getCache(requestID);
}

export async function getMod(modID: string): Promise<FicsitAppMod> {
  const requestID = `getMod_${modID}`;
  if (cooldownPassed(requestID)) {
    const res = await fiscitApiQuery(`
    query($modID: ModID!){
      getMod(modId: $modID)
      {
          name,
          short_description,
          full_description,
          id,
          logo,
          downloads,
          hotness,
          popularity,
          last_version_date,
          authors
          {
            mod_id,
            user
            {
              username,
              avatar
            },
            role
          },
          versions
          {
            mod_id,
            version,
            sml_version,
            changelog,
            downloads,
            stability,
            link
          }
      }
    }
    `, {
      modID,
    });
    if (res.errors) {
      throw res.errors;
    } else {
      const { getMod: resGetMod } = res;
      if (resGetMod === null) {
        if (useTempMods) {
          const tempMod = tempMods.find((mod) => mod.id === modID);
          if (tempMod) {
            return tempMod;
          }
        }
        throw new ModNotFoundError(`Mod ${modID} not found`);
      }
      resGetMod.last_version_date = resGetMod.last_version_date ? new Date(resGetMod.last_version_date) : null;
      setCache(requestID, resGetMod);
    }
  }
  return getCache(requestID);
}

export async function getModVersions(modID: string): Promise<Array<FicsitAppVersion>> {
  const requestID = `getModVersions_${modID}`;
  if (cooldownPassed(requestID)) {
    const res = await fiscitApiQuery(`
      query($modID: ModID!){
        getMod(modId: $modID)
        {
            name,
            id,
            versions(filter: {
                limit: 100
              })
            {
              mod_id,
              version,
              sml_version,
              changelog,
              downloads,
              stability,
              link
            }
        }
      }
      `, {
      modID,
    });
    if (res.errors) {
      throw res.errors;
    } else if (res.getMod) {
      setCache(requestID, res.getMod.versions);
    } else {
      if (useTempMods) {
        const tempMod = tempMods.find((mod) => mod.id === modID);
        if (tempMod) {
          return tempMod.versions;
        }
      }
      throw new ModNotFoundError(`Mod ${modID} not found`);
    }
  }
  return getCache(requestID);
}

export async function getModLatestVersion(modID: string): Promise<FicsitAppVersion> {
  const versions = await getModVersions(modID);
  versions.sort((a, b) => -compare(a.version, b.version));
  return versions[0];
}

export async function findVersionMatchingAll(modID: string,
  versionConstraints: Array<string>): Promise<string | undefined> {
  const modInfo = await getMod(modID);
  let finalVersion = '';
  let found = false;
  modInfo.versions.forEach((modVersion) => {
    if (!found && versionSatisfiesAll(modVersion.version, versionConstraints)) {
      found = true;
      finalVersion = modVersion.version;
    }
  });
  return found ? finalVersion : undefined;
}


export interface FicsitAppSMLVersion {
  id: string;
  version: string;
  satisfactory_version: number;
  stability: 'alpha' | 'beta' | 'release';
  link: string;
  changelog: string;
  date: Date;
  bootstrap_version: string;
}

export async function getAvailableSMLVersions(): Promise<Array<FicsitAppSMLVersion>> {
  const requestID = 'getSMLVersions';
  if (cooldownPassed(requestID)) {
    const res = await fiscitApiQuery(`
    {
      getSMLVersions(filter: {limit: 100})
      {
        sml_versions
        {
          id,
          version,
          satisfactory_version
          stability,
          link,
          changelog,
          date,
          bootstrap_version
        }
      }
    }
    `);
    if (res.errors) {
      throw res.errors;
    } else {
      // filter SML versions supported by SMManager
      const smlVersionsCompatible = res.getSMLVersions.sml_versions.filter((version: FicsitAppSMLVersion) => satisfies(version.version, '>=2.0.0'));
      for (let i = 0; i < smlVersionsCompatible.length; i += 1) {
        smlVersionsCompatible[i].date = smlVersionsCompatible[i].date ? new Date(smlVersionsCompatible[i].date) : null;
      }
      setCache(requestID, smlVersionsCompatible);
    }
  }
  return getCache(requestID);
}

export interface FicsitAppBootstrapperVersion {
  id: string;
  version: string;
  satisfactory_version: number;
  stability: 'alpha' | 'beta' | 'release';
  link: string;
  changelog: string;
  date: Date;
}

export async function getAvailableBootstrapperVersions(): Promise<Array<FicsitAppBootstrapperVersion>> {
  const requestID = 'getBootstrapperVersions';
  if (cooldownPassed(requestID)) {
    const res = await fiscitApiQuery(`
    {
      getBootstrapVersions(filter: {limit: 100})
      {
        bootstrap_versions
        {
          id,
          version,
          satisfactory_version,
          stability,
          link,
          changelog,
          date
        }
      }
    }
    `);
    if (res.errors) {
      throw res.errors;
    } else {
      const resGetBootstrapVersions = res.getBootstrapVersions.bootstrap_versions;
      for (let i = 0; i < resGetBootstrapVersions.length; i += 1) {
        resGetBootstrapVersions[i].date = resGetBootstrapVersions[i].date ? new Date(resGetBootstrapVersions[i].date) : null;
      }
      setCache(requestID, resGetBootstrapVersions);
    }
  }
  return getCache(requestID);
}

export async function getSMLVersionInfo(version: string): Promise<FicsitAppSMLVersion | undefined> {
  const versions = await getAvailableSMLVersions();
  return versions.find((smlVersion) => smlVersion.version === version);
}

export async function getLatestSMLVersion(): Promise<FicsitAppSMLVersion> {
  const versions = await getAvailableSMLVersions();
  versions.sort((a, b) => -compare(a.version, b.version));
  return versions[0];
}

export async function getBootstrapperVersionInfo(version: string): Promise<FicsitAppBootstrapperVersion | undefined> {
  const versions = await getAvailableBootstrapperVersions();
  return versions.find((bootstrapperVersion) => bootstrapperVersion.version === version);
}

export async function getLatestBootstrapperVersion(): Promise<FicsitAppBootstrapperVersion> {
  const versions = await getAvailableBootstrapperVersions();
  versions.sort((a, b) => -compare(a.version, b.version));
  return versions[0];
}

export async function findAllVersionsMatchingAll(modID: string, versionConstraints: Array<string>): Promise<Array<string>> {
  if (modID === SMLModID) {
    const smlVersions = await getAvailableSMLVersions();
    return smlVersions
      .filter((smlVersion) => satisfies(smlVersion.version, `>=${minSMLVersion}`))
      .filter((smlVersion) => versionSatisfiesAll(smlVersion.version, versionConstraints))
      .map((smlVersion) => smlVersion.version);
  }
  if (modID === BootstrapperModID) {
    const bootstrapperVersions = await getAvailableBootstrapperVersions();
    return bootstrapperVersions
      .filter((bootstrapperVersion) => versionSatisfiesAll(bootstrapperVersion.version, versionConstraints))
      .map((bootstrapperVersion) => bootstrapperVersion.version);
  }
  const modInfo = await getMod(modID);
  return modInfo.versions
    .filter((modVersion) => versionSatisfiesAll(modVersion.version, versionConstraints))
    .map((modVersion) => modVersion.version);
}
