// Script Properties 裡的保管人清單、書目版本與部署 ID。只有試算表擁有者能改。

import { DEFAULT_HOLDER } from "../../core/books.ts";

const KEY = {
  holders: "holders",
  catalogVersion: "catalogVersion",
  deploymentId: "deploymentId",
} as const;

function props(): GoogleAppsScript.Properties.Properties {
  return PropertiesService.getScriptProperties();
}

export function getHolders(): string[] {
  const stored = props().getProperty(KEY.holders);
  return stored ? (JSON.parse(stored) as string[]) : [DEFAULT_HOLDER];
}

export function saveHolders(holders: string[]): void {
  props().setProperty(KEY.holders, JSON.stringify(holders));
  bumpCatalogVersion();
}

export function catalogVersion(): string {
  return props().getProperty(KEY.catalogVersion) ?? "0";
}

/** Books 或保管人清單變了：各裝置下次同步時重抓書目快取。 */
export function bumpCatalogVersion(): void {
  props().setProperty(KEY.catalogVersion, String(Date.now()));
}

export function deploymentId(): string | null {
  return props().getProperty(KEY.deploymentId);
}

export function storeDeploymentId(id: string): void {
  if (props().getProperty(KEY.deploymentId) !== id) props().setProperty(KEY.deploymentId, id);
}
