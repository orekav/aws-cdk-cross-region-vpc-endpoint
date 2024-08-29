#!/opt/homebrew/opt/node/bin/node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import {
  ConsumerConnectorStack,
  ConsumerStack,
  ProviderConnectorStack,
  ProviderStack,
} from "../lib/stacks";

const REGION_A = "us-east-2";
const REGION_B = "eu-west-1";
const VERSION = "2";

const app = new cdk.App();

const providerConnectorStack = new ProviderConnectorStack(
  app,
  `${ProviderConnectorStack.name}-${VERSION}`,
  {
    env: { region: REGION_A },
  },
);

const consumerConnectorStack = new ConsumerConnectorStack(
  app,
  `${ConsumerConnectorStack.name}-${VERSION}`,
  {
    env: { region: REGION_A },
    externalVpc: providerConnectorStack.vpc,
  },
);

const providerStack = new ProviderStack(
  app,
  `${ProviderStack.name}-${VERSION}`,
  {
    env: { region: REGION_A },
    vpc: providerConnectorStack.vpc,
    externalVpcEndpoints: [consumerConnectorStack.vpcEndpoint],
  },
);

const consumerStack = new ConsumerStack(
  app,
  `${ConsumerStack.name}-${VERSION}`,
  {
    crossRegionReferences: true,
    env: { region: REGION_B },
    restApi: providerStack.restApi,
    vpcEndpoint: consumerConnectorStack.vpcEndpoint,
    peer: {
      vpc: consumerConnectorStack.vpc,
      role: consumerConnectorStack.vpcPeeringRole,
    },
  },
);
