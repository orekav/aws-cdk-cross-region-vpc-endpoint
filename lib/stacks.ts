import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import path = require("path");

export class AccepterStack extends cdk.Stack {
  public readonly vpc: cdk.aws_ec2.Vpc;
  public readonly vpcEndpoint: cdk.aws_ec2.InterfaceVpcEndpoint;
  public readonly vpcPeeringRole: cdk.aws_iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new cdk.aws_ec2.Vpc(this, "Vpc", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.0.0.0/16"),
    });

    this.vpcEndpoint = this.vpc.addInterfaceEndpoint("VpcEndpoint", {
      privateDnsEnabled: true,
      service: cdk.aws_ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
    });

    this.vpcPeeringRole = new cdk.aws_iam.Role(
      this,
      "AcceptVpcPeeringFromRequesterAccountRole",
      {
        roleName: "AcceptVpcPeeringFromSecondaryAccountRole",
        assumedBy: new cdk.aws_iam.AccountRootPrincipal(),
      }
    );
    this.vpcPeeringRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ec2:AcceptVpcPeeringConnection"],
        resources: ["*"],
      })
    );

    const lambda = new cdk.aws_lambda_nodejs.NodejsFunction(this, "Lambda", {
      entry: path.resolve(__dirname, "./lambda/index.mjs"),
      architecture: cdk.aws_lambda.Architecture.ARM_64,
      runtime: cdk.aws_lambda.Runtime.NODEJS_20_X,
      insightsVersion: cdk.aws_lambda.LambdaInsightsVersion.VERSION_1_0_317_0,
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
      environment: {
        API_URL: "https://api.example.com",
      },
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });
  }
}

export class RequesterStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & {
      peer: {
        vpc: cdk.aws_ec2.Vpc;
        region: string;
        role: cdk.aws_iam.IRole;
      };
      restApi: cdk.aws_apigateway.RestApi;
    }
  ) {
    super(scope, id, props);

    const vpc = new cdk.aws_ec2.Vpc(this, "Vpc", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.1.0.0/16"),
    });

    const peeringConnection = new cdk.aws_ec2.CfnVPCPeeringConnection(
      this,
      "VpcPeeringConnection",
      {
        vpcId: vpc.vpcId,
        peerVpcId: props.peer.vpc.vpcId,
        peerRegion: props.peer.region,
        peerRoleArn: props.peer.role.roleArn,
      }
    );

    vpc.privateSubnets.forEach(({ routeTable: { routeTableId } }, index) => {
      const route = new cdk.aws_ec2.CfnRoute(
        this,
        "IsolatedSubnetPeeringConnectionRoute" + index,
        {
          destinationCidrBlock: props.peer.vpc.vpcCidrBlock,
          routeTableId,
          vpcPeeringConnectionId: peeringConnection.ref,
        }
      );
      route.addDependency(peeringConnection);
    });

    const lambda = new cdk.aws_lambda_nodejs.NodejsFunction(this, "Lambda", {
      entry: path.resolve(__dirname, "./lambda/index.mjs"),
      architecture: cdk.aws_lambda.Architecture.ARM_64,
      runtime: cdk.aws_lambda.Runtime.NODEJS_20_X,
      insightsVersion: cdk.aws_lambda.LambdaInsightsVersion.VERSION_1_0_317_0,
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
      environment: {
        API_URL: props.restApi.url,
      },
      vpc: vpc,
      vpcSubnets: {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    lambda.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [props.restApi.arnForExecuteApi()],
      })
    );
  }
}

export class ProviderStack extends cdk.Stack {
  public readonly restApi: cdk.aws_apigateway.RestApi;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { vpcEndpoint: cdk.aws_ec2.InterfaceVpcEndpoint }
  ) {
    super(scope, id, props);

    const vpc = new cdk.aws_ec2.Vpc(this, "Vpc", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.0.0.0/24"),
      maxAzs: 3,
      subnetConfiguration: [
        {
          cidrMask: 27,
          name: "private",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 27,
          name: "public",
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const vpcEndpoint = vpc.addInterfaceEndpoint("VpcEndpoint", {
      privateDnsEnabled: true,
      service: cdk.aws_ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
    });

    const apiResourcePolicy = new cdk.aws_iam.PolicyDocument({
      statements: [
        new cdk.aws_iam.PolicyStatement({
          effect: cdk.aws_iam.Effect.DENY,
          principals: [new cdk.aws_iam.StarPrincipal()],
          actions: ["execute-api:Invoke"],
          resources: ["execute-api:/*"],
          conditions: {
            StringNotEquals: {
              "aws:sourceVpce": [
                vpcEndpoint.vpcEndpointId,
                props.vpcEndpoint.vpcEndpointId,
              ],
            },
          },
        }),
        new cdk.aws_iam.PolicyStatement({
          effect: cdk.aws_iam.Effect.ALLOW,
          principals: [new cdk.aws_iam.StarPrincipal()],
          actions: ["execute-api:Invoke"],
          resources: ["execute-api:/*"],
          conditions: {
            StringEquals: {
              "aws:sourceVpce": [
                vpcEndpoint.vpcEndpointId,
                props.vpcEndpoint.vpcEndpointId,
              ],
            },
          },
        }),
      ],
    });

    this.restApi = new cdk.aws_apigateway.RestApi(this, "RestApi", {
      endpointConfiguration: {
        types: [cdk.aws_apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [vpcEndpoint, props.vpcEndpoint],
      },
      policy: apiResourcePolicy,
    });

    this.restApi.root.addMethod(
      "GET",
      new cdk.aws_apigateway.HttpIntegration(
        "https://jsonplaceholder.typicode.com/todos/1"
      )
    );
  }
}
