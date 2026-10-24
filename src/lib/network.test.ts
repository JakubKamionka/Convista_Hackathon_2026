import { createServer, type Server } from "node:net";
import { request } from "node:https";
import { assertSapTarget, createSapAgent } from "./network";
import { cleanup, createAxiosInstance } from "./utils";
import { setConnectivityProxy } from "../config";

const config = {
  url: "https://sap.example.com:44300",
  username: "u",
  password: "p",
  client: "300",
};
const origin = config.url;

describe("assertSapTarget", () => {
  it.each([
    `${origin}/sap/bc/adt/programs/programs/ZTEST`,
    `${origin}/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner`,
  ])("allows %s", (url) => {
    expect(() => assertSapTarget(url, config)).not.toThrow();
  });

  it.each([
    `${origin}/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartnerAddress`,
    `${origin}/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner/x`,
    `${origin}/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder`,
    `${origin}/sap/bc/gui/sap/its/webgui`,
    `https://evil.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner`,
    `https://u:p@sap.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner`,
    `${origin}/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner#x`,
  ])("rejects %s", (url) => {
    expect(() => assertSapTarget(url, config)).toThrow(
      "SAP request target must stay within the configured ADT origin",
    );
  });
});

describe("createSapAgent with connectivity proxy", () => {
  it("sends the Connectivity token in the CONNECT request", async () => {
    const connect = await new Promise<string>((resolve) => {
      const proxy: Server = createServer((socket) => {
        socket.once("data", (chunk) => {
          resolve(chunk.toString());
          socket.destroy();
          proxy.close();
        });
      });
      proxy.listen(0, "127.0.0.1", () => {
        const port = (proxy.address() as { port: number }).port;
        const agent = createSapAgent({
          ...config,
          url: origin,
          proxy: {
            host: "127.0.0.1",
            port,
            authorization: "Bearer conn-token",
          },
        });
        const req = request({
          host: "sap.example.com",
          port: 44300,
          path: "/",
          agent,
        });
        req.on("error", () => undefined);
        req.end();
        proxy.once("close", () => agent.destroy());
      });
    });

    expect(connect).toMatch(/^CONNECT sap\.example\.com:44300 HTTP\/1\.1/);
    expect(connect).toMatch(/Proxy-Authorization: Bearer conn-token/);
  });

  it("sends plain http targets as HTTP proxy requests, not CONNECT", async () => {
    const received = new Promise<string>((resolve) => {
      const proxy: Server = createServer((socket) => {
        socket.once("data", (chunk) => {
          resolve(chunk.toString());
          socket.destroy();
          proxy.close();
        });
      });
      proxy.listen(0, "127.0.0.1", () => {
        const port = (proxy.address() as { port: number }).port;
        Object.assign(process.env, {
          SAP_URL: "http://sap.example.com:8000",
          SAP_USERNAME: "u",
          SAP_PASSWORD: "p",
          SAP_CLIENT: "300",
        });
        setConnectivityProxy({
          host: "127.0.0.1",
          port,
          authorization: "Bearer conn-token",
        });
        cleanup();
        createAxiosInstance()
          .get("http://sap.example.com:8000/sap/bc/adt/discovery")
          .catch(() => undefined);
      });
    });

    const head = await received;
    setConnectivityProxy(undefined);
    cleanup();
    expect(head).toMatch(
      /^GET http:\/\/sap\.example\.com:8000\/sap\/bc\/adt\/discovery HTTP\/1\.1/,
    );
    expect(head).toMatch(/Proxy-Authorization: Bearer conn-token/i);
  });
});
