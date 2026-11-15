// Script Properties 裡的班級清單、書目版本與部署 ID。只有試算表擁有者能改。

import { SCHOOL } from "../../core/books.ts";

const KEY = {
  // 已部署的試算表用 holders 這個名稱存班級清單。
  classes: "holders",
  catalogVersion: "catalogVersion",
  deploymentId: "deploymentId",
} as const;

function props(): GoogleAppsScript.Properties.Properties {
  return PropertiesService.getScriptProperties();
}

/** 「學校」與各班級。 */
export function getClasses(): string[] {
  const stored = props().getProperty(KEY.classes);
  return stored ? (JSON.parse(stored) as string[]) : [SCHOOL];
}

export function saveClasses(classes: string[]): void {
  props().setProperty(KEY.classes, JSON.stringify(classes));
  bumpCatalogVersion();
}

export function catalogVersion(): string {
  return props().getProperty(KEY.catalogVersion) ?? "0";
}

/** Books、幼兒分頁或班級清單變了：各裝置下次同步時重抓書目快取與幼兒名單。 */
export function bumpCatalogVersion(): void {
  props().setProperty(KEY.catalogVersion, String(Date.now()));
}

export function deploymentId(): string | null {
  return props().getProperty(KEY.deploymentId);
}

export function storeDeploymentId(id: string): void {
  if (props().getProperty(KEY.deploymentId) !== id) props().setProperty(KEY.deploymentId, id);
}
