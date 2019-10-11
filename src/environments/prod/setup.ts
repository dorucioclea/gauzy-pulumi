import * as awsx from "@pulumi/awsx";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as db from "../../db";
import * as config from "../../config";
import * as backendAPI from "./backend-api";
import * as frontend from "./frontend";
import { Environment } from "../environments";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";

const managedPolicyArns: string[] = [
  "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
  "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
];

/**
 * Creates a role and attaches IAM managed policies to the EKS worker node
 * @param name 
 */
function createAndAttachRole(name: string): aws.iam.Role {
  const role = new aws.iam.Role(name, {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: "ec2.amazonaws.com",
      }),
  });

  let counter = 0;

  for (const policy of managedPolicyArns) {      
      new aws.iam.RolePolicyAttachment(`${name}-policy-${counter++}`,
          { policyArn: policy, role: role },
      );
  }

  return role;
}

export const setupProdEnvironment = async (dockerImages: { apiImage: awsx.ecr.RepositoryImage; webappImage: awsx.ecr.RepositoryImage; }) => {    
  const dbCluster = await db.createPostgreSQLCluster(Environment.Prod);

  dbCluster.endpoint.apply(async (dbHost: any) => {
    const port = parseInt(<string>process.env.DB_PORT, 10);
    await db.check(Environment.Prod, dbHost, port);

    // Allocate a new VPC with custom settings, and a public & private subnet per AZ.
    const vpc = new awsx.ec2.Vpc("gauzy-prod-vpc", {
      cidrBlock: "172.16.0.0/16",
      subnets: [{ type: "public" }, { type: "private" }]
    });
    
    // we deploy Serverless DB to default VPC, now we need to create peering between them    
    // see https://github.com/pulumi/pulumi-aws/blob/master/sdk/nodejs/ec2/peeringConnectionOptions.ts
    // So we create following Peer Connection:
    // Requester VPC: RDS VPC
    // Requester CIDRs: 172.31.0.0/16
    // Accepter VPC: EKS VPC
    // Accepter CIDRs: 172.16.0.0/16
    // For DNS we enable both ways resolution for now

    const vpcDb = awsx.ec2.Vpc.getDefault();
    
    const vpcPeeringConnection = new aws.ec2.VpcPeeringConnection("vpc-peering", {
      autoAccept: true,
      peerVpcId: vpc.id,
      vpcId: vpcDb.id      
    });
    
    const peeringConnectionOptions = new aws.ec2.PeeringConnectionOptions("vpc-peering", {      
          accepter: {            
              allowClassicLinkToRemoteVpc: true,
              allowVpcToRemoteClassicLink: true,
              allowRemoteVpcDnsResolution: true
           },
           requester: {
              allowRemoteVpcDnsResolution: true,
              allowClassicLinkToRemoteVpc: true,
              allowVpcToRemoteClassicLink: true              
           },           
           vpcPeeringConnectionId: vpcPeeringConnection.id           
    });

    // TODO: for each of EKS VPC route tables, we need to add following:
    // Destination: 172.31.0.0/16, Target: pcx-0d0361d11b98223e4 (peer connection)
    // For RDS VPC route tables, we need to add following:
    // Destination: 172.16.0.0/16, Target: pcx-0d0361d11b98223e4 (peer connection)

    const allVpcSubnetsIds = vpc.privateSubnetIds.concat(vpc.publicSubnetIds);

    // Create the EKS cluster, including a "gp2"-backed StorageClass
    const cluster = new eks.Cluster("gauzy-prod", {      
      version: "1.14",
      vpcId: vpc.id,
      subnetIds: allVpcSubnetsIds,
      instanceType: "t3.medium",
      desiredCapacity: 2,
      minSize: 1,
      maxSize: 2,
      storageClasses: "gp2",
      enabledClusterLogTypes: [
        "api",
        "audit",
        "authenticator",
        "controllerManager",
        "scheduler"
      ],
      skipDefaultNodeGroup: false
    });

    // We are using https://github.com/helm/charts/tree/master/stable/kubernetes-dashboard    
    
    // Run `kubectl create clusterrolebinding kubernetes-dashboard --clusterrole=cluster-admin --serviceaccount=default:kubernetes-dashboard`
    // (note: not secure enough, but fine for testing)

    // Dashboard should be available at http://localhost:8001/api/v1/namespaces/kube-system/services/https:kubernetes-dashboard:/proxy/#!/login
    // after running `kubectl proxy`

    // Next, to get token run following command:
    // kubectl -n kube-system describe secrets `kubectl -n kube-system get secrets | awk '/clusterrole-aggregation-controller/ {print $1}'` | awk '/token:/ {print $2}'
    // (you need to use bash)

    // See also:
    // - https://github.com/kubernetes/dashboard/issues/2474
    // - https://github.com/pulumi/pulumi-kubernetes/issues/600
    // - https://github.com/kubernetes/dashboard/blob/master/docs/user/access-control/README.md

    const k8sDashboardChart = new k8s.helm.v2.Chart("kubernetes-dashboard", {
      repo: "stable",
      chart: "kubernetes-dashboard"      
    }, {providers: {kubernetes: cluster.provider}});

    const kubeconfig = cluster.kubeconfig;
    
    const clusterName = cluster.core.cluster.name;

    // Create a Kubernetes Namespace for our production app API and front-end
    // NOTE: SaaS may use same k8s cluster, but create different namespaces, one per tenant
    const ns = new k8s.core.v1.Namespace(
      "gauzy-prod",
      {        
      },
      { provider: cluster.provider }
    );

    const namespaceName = ns.metadata.name;

    const backendAPIResponse = await backendAPI.createBackendAPI(
      dockerImages.apiImage,
      cluster,
      namespaceName,
      dbHost,
      port
    );

    backendAPIResponse.serviceHostname.apply(
      async (serviceHostname: string) => {
        backendAPIResponse.port.apply(async (port: number) => {

          // e.g. http://af91c38e5e3cd11e9a4af1292f67fc7d-708947058.us-east-1.elb.amazonaws.com:3000
          const backendApiUrl = pulumi.interpolate`http://${serviceHostname}:${port}`;

          backendApiUrl.apply(it => {
            console.log(`API Url: ${it}`);
          });
          
          const frontendResponse = await frontend.createFrontend(
            dockerImages.webappImage,          
            cluster,
            namespaceName,
            config.fullProdApiUrl
          );

          frontendResponse.serviceHostname.apply(
            async (serviceHostname: string) => {
              frontendResponse.port.apply(async (port: number) => {
                
                // e.g. http://a07be926ce3ce11e9a4af1292f67fc7d-278090253.us-east-1.elb.amazonaws.com:4200
                const frontendAppUrl = pulumi.interpolate`http://${serviceHostname}:${port}`;

                frontendAppUrl.apply(it => {
                  console.log(`Frontend Url: ${it}`);
                });                

                kubeconfig.apply(it => {
                  console.log(`KubeConfig: ${JSON.stringify(it)}`);
                });
            
                clusterName.apply(it => {
                  console.log(`ClusterName: ${JSON.stringify(it)}`);
                });

              });
            }
          );
        });
      }
    );
  });
};
