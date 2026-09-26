// Small mutable runtime state shared by the search framework. This avoids
// circular imports between the change hooks (which are called from business
// services) and the registry/vocabulary (which is loaded from the database).
export const searchState = {
  enabled: false,
  initialized: false,
  objectTypes: new Set(),
};

export function isSearchEnabled() {
  return searchState.enabled;
}

export function setRegisteredObjectTypes(codes) {
  searchState.objectTypes = new Set(codes || []);
}

export function isRegisteredObjectType(code) {
  return searchState.objectTypes.has(code);
}

export function setSearchEnabled(value) {
  searchState.enabled = Boolean(value);
  return searchState.enabled;
}
