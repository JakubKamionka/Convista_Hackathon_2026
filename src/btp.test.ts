import axios from "axios";
import { bindingCredentials, connectSap, tokenEndpoint } from "./btp";
import { getConfig, setConnectivityProxy } from "./config";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const VCAP = JSON.stringify({
  destination: [
    {
      credentials: {
        uri: "https://destination-configuration.example",
        url: "https://uaa.example",
        clientid: "dest-id",
        clientsecret: "dest-secret",
      },
    },
  ],
  connectivity: [
    {
      credentials: {
        token_service_url: "https://uaa.example",
        clientid: "conn-id",
        clientsecret: "conn-secret",
        onpremise_proxy_host: "connectivityproxy.example",
        onpremise_proxy_port: "20003",
      },
    },
  ],
});

const savedEnv = process.env;

beforeEach(() => {
  process.env = {
    ...savedEnv,
    VCAP_SERVICES: VCAP,
    SAP_DESTINATION: "SA1_300",
  };
  delete process.env.SAP_URL;
  setConnectivityProxy(undefined);
  mockedAxios.post.mockReset();
  mockedAxios.get.mockReset();
  mockedAxios.post.mockResolvedValueOnce({
    data: { access_token: "dest-token", expires_in: 3600 },
  });
});

afterAll(() => {
  process.env = savedEnv;
});

function mockDestination(destinationConfiguration: Record<string, string>) {
  mockedAxios.get.mockResolvedValueOnce({ data: { destinationConfiguration } });
}

describe("bindingCredentials", () => {
  it("returns the credentials of the bound service label", () => {
    expect(bindingCredentials(VCAP, "connectivity")?.clientid).toBe("conn-id");
  });

  it("returns undefined when the label is not bound", () => {
    expect(bindingCredentials(VCAP, "missing")).toBeUndefined();
    expect(bindingCredentials(undefined, "destination")).toBeUndefined();
  });
});

describe("connectSap", () => {
  it("does nothing without SAP_DESTINATION", async () => {
    delete process.env.SAP_DESTINATION;
    await expect(connectSap()).resolves.toBeUndefined();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("fails without a bound destination service", async () => {
    process.env.VCAP_SERVICES = "{}";
    await expect(connectSap()).rejects.toThrow(
      "no destination service is bound",
    );
  });

  it("resolves an OnPremise destination through the connectivity proxy", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { access_token: "conn-token", expires_in: 3600 },
    });
    mockDestination({
      URL: "https://CV-VM-SAP001:44300",
      Authentication: "BasicAuthentication",
      ProxyType: "OnPremise",
      User: "sapuser",
      Password: "sappass",
      "sap-client": "300",
    });

    const refreshMs = await connectSap();

    expect(refreshMs).toBe(2_880_000);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://destination-configuration.example/destination-configuration/v1/destinations/SA1_300",
      expect.objectContaining({
        headers: { Authorization: "Bearer dest-token" },
      }),
    );
    const config = getConfig();
    expect(config).toMatchObject({
      url: "https://cv-vm-sap001:44300",
      username: "sapuser",
      password: "sappass",
      client: "300",
      proxy: {
        host: "connectivityproxy.example",
        port: 20003,
        authorization: "Bearer conn-token",
      },
    });
  });

  it("connects directly for an Internet destination", async () => {
    mockDestination({
      URL: "https://sap.example.com:44300",
      Authentication: "BasicAuthentication",
      ProxyType: "Internet",
      User: "sapuser",
      Password: "sappass",
    });
    process.env.SAP_CLIENT = "100";

    await connectSap();

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(getConfig()).toMatchObject({ client: "100", proxy: undefined });
  });

  it("rejects destinations that do not use basic authentication", async () => {
    mockDestination({
      URL: "https://sap.example.com:44300",
      Authentication: "OAuth2ClientCredentials",
      ProxyType: "Internet",
    });
    await expect(connectSap()).rejects.toThrow("must use BasicAuthentication");
  });

  it("tunnels an OnPremise destination that uses plain http", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { access_token: "conn-token", expires_in: 3600 },
    });
    mockDestination({
      URL: "http://CV-VM-SAP001:8000",
      Authentication: "BasicAuthentication",
      ProxyType: "OnPremise",
      User: "sapuser",
      Password: "sappass",
      "sap-client": "300",
    });

    await connectSap();

    expect(getConfig()).toMatchObject({
      url: "http://cv-vm-sap001:8000",
      proxy: { host: "connectivityproxy.example", port: 20003 },
    });
  });
});

describe("tokenEndpoint", () => {
  it("appends /oauth/token to a bare UAA URL", () => {
    expect(tokenEndpoint("https://uaa.example")).toBe(
      "https://uaa.example/oauth/token",
    );
    expect(tokenEndpoint("https://uaa.example/")).toBe(
      "https://uaa.example/oauth/token",
    );
  });

  it("keeps a URL that already names the token endpoint", () => {
    expect(tokenEndpoint("https://uaa.example/oauth/token")).toBe(
      "https://uaa.example/oauth/token",
    );
  });
});
