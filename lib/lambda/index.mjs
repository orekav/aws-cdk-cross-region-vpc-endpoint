/*global fetch*/
import dns from "dns";
import util from "util";
const lookup = util.promisify(dns.lookup);

const API_URL = process.env.API_URL;
const VPC_ENDPOINT_ID = process.env.VPC_ENDPOINT_ID;

const url = new URL(process.env.API_URL);

// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-api-create.html?icmpid=apigateway_console_help#apigateway-private-api-create-interface-vpc-endpoint
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-api-test-invoke-url.html#apigateway-private-api-route53-alias
if (VPC_ENDPOINT_ID) {
  const [subdomain, ...rest] = url.hostname.split(".");
  url.hostname = [`${subdomain}-${VPC_ENDPOINT_ID}`, ...rest].join(".");
}

export async function handler(event, context) {
  console.log("Event", JSON.stringify({ event, context }, null, 2));

  const result = await lookup(url.hostname);
  console.log("DNS result", result);

  const response = await fetch(url);

  return {
    message: "Hello World",
    status: response.status,
    body: await response.text(),
    headers: response.headers,
  };
}
