import axios from "axios";
import { setConnectivityProxy } from "./config";
import { cleanup } from "./lib/utils";

// Resolves the SAP connection on SAP BTP Cloud Foundry from the bound
// Destination and Connectivity services. Without SAP_DESTINATION the SAP_*
// environment variables are used unchanged (local and stdio runs).

type Credentials = Record<string, string>;

interface DestinationConfiguration {
  URL?: string;
  Authentication?: string;
  ProxyType?: string;
  User?: string;
  Password?: string;
  "sap-client"?: string;
}

const TIMEOUT_MS = 30_000;
const MIN_REFRESH_MS = 60_000;
const DEFAULT_LIFETIME_S = 1800;

// Falls back to a conservative lifetime when a token response has no usable
// expires_in, so the refresh timer never gets a NaN or zero delay.
function lifetimeSeconds(expiresIn: unknown): number {
  return typeof expiresIn === "number" && expiresIn > 0
    ? expiresIn
    : DEFAULT_LIFETIME_S;
}

export function bindingCredentials(
  vcapServices: string | undefined,
  label: string,
): Credentials | undefined {
  return JSON.parse(vcapServices || "{}")[label]?.[0]?.credentials;
}

// Adds the BTP step to the error. Only the step, HTTP status and error code
// are reported, never the request URL, headers or the token-bearing body.
async function labelled<T>(step: string, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    // UAA and the destination service return a short error code, e.g. "invalid_client".
    const code = axios.isAxiosError(error)
      ? error.response?.data?.error
      : undefined;
    throw new Error(
      `${step} failed${status ? ` with HTTP ${status}` : ""}${typeof code === "string" ? ` (${code})` : ""}`,
    );
  }
}

async function clientCredentialsToken(
  tokenUrl: string,
  credentials: Credentials,
): Promise<{ access_token: string; expires_in: number }> {
  const { data } = await axios.post(
    tokenUrl,
    new URLSearchParams({ grant_type: "client_credentials" }),
    {
      auth: {
        username: credentials.clientid,
        password: credentials.clientsecret,
      },
      // axios' default Accept (text/html-style list) makes UAA reject the
      // request as a browser CSRF failure (403), so ask for any type.
      headers: { Accept: "*/*" },
      timeout: TIMEOUT_MS,
    },
  );
  // A login page (wrong token URL) also answers 200, so require a real token.
  if (typeof data?.access_token !== "string" || !data.access_token)
    throw new Error("Token response has no access_token");
  return data;
}

// Bindings give the UAA base URL, with or without the /oauth/token path.
export function tokenEndpoint(base: string): string {
  const url = base.replace(/\/+$/, "");
  return url.endsWith("/oauth/token") ? url : `${url}/oauth/token`;
}

// Returns the milliseconds until the tokens should be refreshed, or undefined
// when no destination is configured.
export async function connectSap(): Promise<number | undefined> {
  const name = process.env.SAP_DESTINATION;
  if (!name) return undefined;

  const destination = bindingCredentials(
    process.env.VCAP_SERVICES,
    "destination",
  );
  if (!destination?.uri || !destination.url)
    throw new Error(
      "SAP_DESTINATION is set but no destination service is bound",
    );

  const destinationToken = await labelled(
    "Destination service token request",
    clientCredentialsToken(tokenEndpoint(destination.url), destination),
  );
  const { data } = await labelled(
    `Reading destination ${name}`,
    axios.get<{
      destinationConfiguration: DestinationConfiguration;
    }>(
      `${destination.uri}/destination-configuration/v1/destinations/${encodeURIComponent(name)}`,
      {
        headers: { Authorization: `Bearer ${destinationToken.access_token}` },
        timeout: TIMEOUT_MS,
      },
    ),
  );
  const config = data.destinationConfiguration;
  if (config.Authentication !== "BasicAuthentication")
    throw new Error(`Destination ${name} must use BasicAuthentication`);
  if (!config.URL || !config.User || !config.Password)
    throw new Error(`Destination ${name} is missing URL, User or Password`);

  const sapUrl = new URL(config.URL);
  let expiresIn = lifetimeSeconds(destinationToken.expires_in);
  if (config.ProxyType === "OnPremise") {
    // An http URL is tunnelled as plain text from the Cloud Connector to SAP
    // (the BTP-to-Cloud-Connector leg stays encrypted). Basic credentials are
    // therefore only as protected as the internal network behind the connector.
    const connectivity = bindingCredentials(
      process.env.VCAP_SERVICES,
      "connectivity",
    );
    if (
      !connectivity?.token_service_url ||
      !connectivity.onpremise_proxy_host ||
      !connectivity.onpremise_proxy_port
    )
      throw new Error(
        "SAP_DESTINATION is OnPremise but no connectivity service is bound",
      );
    const connectivityToken = await labelled(
      "Connectivity service token request",
      clientCredentialsToken(
        tokenEndpoint(connectivity.token_service_url),
        connectivity,
      ),
    );
    setConnectivityProxy({
      host: connectivity.onpremise_proxy_host,
      port: Number(connectivity.onpremise_proxy_port),
      authorization: `Bearer ${connectivityToken.access_token}`,
    });
    expiresIn = Math.min(
      expiresIn,
      lifetimeSeconds(connectivityToken.expires_in),
    );
  } else {
    setConnectivityProxy(undefined);
  }

  process.env.SAP_URL = sapUrl.origin;
  process.env.SAP_USERNAME = config.User;
  process.env.SAP_PASSWORD = config.Password;
  process.env.SAP_CLIENT = config["sap-client"] ?? process.env.SAP_CLIENT ?? "";
  // Drop the cached axios instance so the next request uses the new agent.
  cleanup();

  return Math.max(MIN_REFRESH_MS, expiresIn * 800);
}

function scheduleRefresh(delayMs: number): void {
  const timer = setTimeout(() => {
    connectSap()
      .then((next) => scheduleRefresh(next ?? MIN_REFRESH_MS))
      .catch((error: Error) => {
        // Never log the destination or token values, only the failure reason.
        console.error(
          `SAP connection refresh failed, retrying: ${error.message}`,
        );
        scheduleRefresh(MIN_REFRESH_MS);
      });
  }, delayMs);
  timer.unref();
}

export async function startSapConnection(): Promise<void> {
  const delayMs = await connectSap();
  if (delayMs !== undefined) scheduleRefresh(delayMs);
}
