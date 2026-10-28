export function sampleAwsKey() {
  return ['AKI', 'A'].join('') + 'A'.repeat(16);
}

export function sampleGithubToken() {
  return ['ghp', '_'].join('') + 'a'.repeat(36);
}

export function sampleGithubFineGrainedToken() {
  return ['github', '_pat_', 'a'.repeat(32)].join('');
}

export function sampleJwt() {
  return `eyJ${'a'.repeat(20)}.${'b'.repeat(10)}.${'c'.repeat(10)}`;
}

export function samplePem() {
  return ['-----BEGIN', ' PRIVATE KEY-----'].join('');
}

export function sampleStripeLive() {
  return ['sk', '_live_'].join('') + 'a'.repeat(16);
}

export function sampleSupabaseRole() {
  return ['supabase', '_service_role'].join('');
}

export function sampleOpenaiKey() {
  return ['sk', '-', 'a'.repeat(20)].join('');
}

export function sampleOpenaiProjectKey() {
  return ['sk', '-proj-', 'a'.repeat(24)].join('');
}

export function sampleAnthropicKey() {
  return ['sk', '-ant-api03-', 'a'.repeat(32)].join('');
}

export function sampleOpenRouterKey() {
  return ['sk', '-or-v1-', 'a'.repeat(32)].join('');
}

export function sampleSlackToken() {
  return ['xox', 'b-', '1'.repeat(12), '-', 'a'.repeat(24)].join('');
}

export function sampleSlackAppToken() {
  return ['xapp', '-1-', 'a'.repeat(32)].join('');
}

export function sampleNpmToken() {
  return ['npm', '_', 'a'.repeat(32)].join('');
}

export function sampleGoogleApiKey() {
  return ['AI', 'za', 'a'.repeat(35)].join('');
}

export function samplePasswordAssignment() {
  return ['password', '=', 'supersecretvalue'].join('');
}
