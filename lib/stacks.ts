import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import path = require("path");

const ACCEPTER_CIDR = "10.0.0.0/16";
const REQUESTER_CIDR = "10.1.0.0/16";
const PROVIDER_CIDR = "10.2.0.0/16";

export class ConsumerConnectorStack extends cdk.Stack {
  public readonly vpc: cdk.aws_ec2.Vpc;
  public readonly vpcEndpoint: cdk.aws_ec2.InterfaceVpcEndpoint;
  public readonly vpcPeeringRole: cdk.aws_iam.Role;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { externalVpc: cdk.aws_ec2.IVpc },
  ) {
    super(scope, id, props);

    this.vpc = new cdk.aws_ec2.Vpc(this, "Vpc", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr(ACCEPTER_CIDR),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          name: "Isolated",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    const securityGroup = new cdk.aws_ec2.SecurityGroup(this, "SecurityGroup", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4(REQUESTER_CIDR),
      cdk.aws_ec2.Port.tcp(443),
      "Allow HTTPS traffic from anywhere",
    );

    this.vpcEndpoint = this.vpc.addInterfaceEndpoint("VpcEndpoint", {
      service: cdk.aws_ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      securityGroups: [securityGroup],
      // https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-api-test-invoke-url.html#w75aac15c20c17c15c15
      // We use the VPC endpoint's DNS name to access the API Gateway
      privateDnsEnabled: false,
    });

    this.vpcPeeringRole = new cdk.aws_iam.Role(
      this,
      "AcceptVpcPeeringFromRequesterAccountRole",
      {
        assumedBy: new cdk.aws_iam.CompositePrincipal(
          new cdk.aws_iam.AccountRootPrincipal(),
        ),
      },
    );
    this.vpcPeeringRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "ec2:AcceptVpcPeeringConnection",
          "ec2:ModifyVpcPeeringConnectionOptions",
        ],
        resources: ["*"],
      }),
    );
  }
}

export class ProviderConnectorStack extends cdk.Stack {
  public readonly vpc: cdk.aws_ec2.IVpc;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new cdk.aws_ec2.Vpc(this, "Vpc", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr(PROVIDER_CIDR),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          name: "Isolated",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
  }
}

export class ConsumerStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & {
      // Destination REST API
      restApi: cdk.aws_apigateway.RestApi;
      // https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-api-test-invoke-url.html#apigateway-private-api-route53-alias
      vpcEndpoint: cdk.aws_ec2.InterfaceVpcEndpoint;
      // for Cross-region VPC peering
      peer: {
        vpc: cdk.aws_ec2.Vpc;
        role: cdk.aws_iam.IRole;
      };
    },
  ) {
    super(scope, id, props);

    const vpc = new cdk.aws_ec2.Vpc(this, "Vpc", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr(REQUESTER_CIDR),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          name: "Isolated",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    const peeringConnection = new cdk.aws_ec2.CfnVPCPeeringConnection(
      this,
      "VpcPeeringConnection",
      {
        vpcId: vpc.vpcId,
        peerVpcId: props.peer.vpc.vpcId,
        peerRegion: props.peer.vpc.stack.region,
        peerRoleArn: props.peer.role.roleArn,
      },
    );

    // Allows traffic from the isolated subnets to the peer VPC
    vpc.isolatedSubnets.forEach(({ routeTable: { routeTableId } }, index) => {
      const route = new cdk.aws_ec2.CfnRoute(
        this,
        "IsolatedSubnetPeeringConnectionRoute" + index,
        {
          routeTableId,
          destinationCidrBlock: props.peer.vpc.vpcCidrBlock,
          vpcPeeringConnectionId: peeringConnection.ref,
        },
      );
      route.addDependency(peeringConnection);
    });

    // NOTE - Traffic from the peer VPC to the isolated subnets has to be MANUALLY allowed in the peer VPC
    // props.peer.vpc.isolatedSubnets.forEach(({ routeTable: { routeTableId } }, index) => {
    //   const route = new cdk.aws_ec2.CfnRoute(
    //     this,
    //     "ExternalIsolatedSubnetPeeringConnectionRoute" + index,
    //     {
    //       routeTableId,
    //       destinationCidrBlock: vpc.vpcCidrBlock,
    //       vpcPeeringConnectionId: peeringConnection.ref,
    //     }
    //   );
    //   route.addDependency(peeringConnection);
    // })

    const lambda = new cdk.aws_lambda_nodejs.NodejsFunction(this, "Lambda", {
      code: cdk.aws_lambda.Code.fromAsset(path.resolve(__dirname, "./lambda")),
      handler: "index.handler",
      architecture: cdk.aws_lambda.Architecture.ARM_64,
      runtime: cdk.aws_lambda.Runtime.NODEJS_20_X,
      insightsVersion: cdk.aws_lambda.LambdaInsightsVersion.VERSION_1_0_317_0,
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
      environment: {
        API_URL: props.restApi.url,
        VPC_ENDPOINT_ID: props.vpcEndpoint.vpcEndpointId,
      },
      vpc: vpc,
      vpcSubnets: {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    lambda.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [props.restApi.arnForExecuteApi()],
      }),
    );
  }
}

export class ProviderStack extends cdk.Stack {
  public readonly restApi: cdk.aws_apigateway.RestApi;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & {
      vpc: cdk.aws_ec2.IVpc;
      externalVpcEndpoints: cdk.aws_ec2.InterfaceVpcEndpoint[];
    },
  ) {
    super(scope, id, props);

    const vpcEndpoint = props.vpc.addInterfaceEndpoint("VpcEndpoint", {
      privateDnsEnabled: true,
      service: cdk.aws_ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
    });

    const apiResourcePolicy = new cdk.aws_iam.PolicyDocument({
      statements: [
        // Prevents access to the API Gateway from any VPC endpoint excepted the specified ones
        new cdk.aws_iam.PolicyStatement({
          effect: cdk.aws_iam.Effect.DENY,
          principals: [new cdk.aws_iam.StarPrincipal()],
          actions: ["execute-api:Invoke"],
          resources: ["execute-api:/*"],
          conditions: {
            StringNotEquals: {
              "aws:sourceVpce": [
                vpcEndpoint.vpcEndpointId,
                ...props.externalVpcEndpoints.map(
                  ({ vpcEndpointId }) => vpcEndpointId,
                ),
              ],
            },
          },
        }),
        // Allows access to the API Gateway from the specified VPC endpoints
        new cdk.aws_iam.PolicyStatement({
          effect: cdk.aws_iam.Effect.ALLOW,
          principals: [new cdk.aws_iam.StarPrincipal()],
          actions: ["execute-api:Invoke"],
          resources: ["execute-api:/*"],
          conditions: {
            StringEquals: {
              "aws:sourceVpce": [
                vpcEndpoint.vpcEndpointId,
                ...props.externalVpcEndpoints.map(
                  ({ vpcEndpointId }) => vpcEndpointId,
                ),
              ],
            },
          },
        }),
      ],
    });

    this.restApi = new cdk.aws_apigateway.RestApi(this, "RestApi", {
      endpointConfiguration: {
        types: [cdk.aws_apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [vpcEndpoint, ...props.externalVpcEndpoints],
      },
      policy: apiResourcePolicy,
    });

    this.restApi.root.addMethod(
      "GET",
      new cdk.aws_apigateway.HttpIntegration(
        "https://jsonplaceholder.typicode.com/todos/1",
      ),
    );
  }
}
