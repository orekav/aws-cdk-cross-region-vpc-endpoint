#!/opt/homebrew/opt/node/bin/node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AccepterStack, RequesterStack, ProviderStack } from "../lib/stacks";

const REGION_A = "us-east-2";
const REGION_B = "eu-west-1";

const app = new cdk.App();

const accepterStack = new AccepterStack(app, AccepterStack.name, {
  env: { region: REGION_A },
});

const providerStack = new ProviderStack(app, ProviderStack.name, {
  env: { region: REGION_A },
  vpcEndpoint: accepterStack.vpcEndpoint,
});

const requesterStack = new RequesterStack(app, RequesterStack.name, {
  env: { region: REGION_B },
  crossRegionReferences: true,
  restApi: providerStack.restApi,
  peer: {
    vpc: accepterStack.vpc,
    region: REGION_A,
    role: accepterStack.vpcPeeringRole,
  },
});
