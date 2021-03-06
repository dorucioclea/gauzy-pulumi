import * as awsx from '@pulumi/awsx';
import * as uuid from 'uuid';
import { Cluster } from '@pulumi/awsx/ecs';
import {
	backendPort,
	sslCoCertificateARN as sslCertificateARN,
	demoApiPort,
} from '../../config';

export const createBackendAPI = async (
	apiImage: awsx.ecs.Image,
	cluster: Cluster,
	dbHost: string,
	dbPort: number
) => {
	// Create ALB (application load balancer), see https://www.pulumi.com/docs/guides/crosswalk/aws/elb
	const alb = new awsx.lb.ApplicationLoadBalancer('gauzy-api-demo', {
		name: 'gauzy-api-demo',
		securityGroups: cluster.securityGroups,
		external: true,
		enableHttp2: true,
		// this can be helpful to avoid accidentally deleting a long-lived, but auto-generated, load balancer URL.
		enableDeletionProtection: false,
	});

	// This defines where requests will be forwarded to (e.g. in our case Fargate Services running and listening on port 4200)
	const apiBackendTarget = alb.createTargetGroup('gauzy-api-demo-target', {
		name: 'gauzy-api-demo-target',
		port: backendPort,
		protocol: 'HTTP',
		healthCheck: {
			unhealthyThreshold: 10,
			timeout: 120,
			interval: 300,
			path: '/api/hello',
			protocol: 'HTTP',
			port: backendPort.toString(),
		},
	});

	const backendAPIListener = apiBackendTarget.createListener(
		'gauzy-api-demo',
		{
			name: 'gauzy-api-demo',
			port: demoApiPort,
			protocol: 'HTTPS',
			external: true,
			certificateArn: sslCertificateARN,
			sslPolicy: 'ELBSecurityPolicy-2016-08',
		}
	);

	const fargateServiceName = 'gauzy-api-' + uuid.v4().split('-')[0];

	console.log(`Backend API Fargate Service Name ${fargateServiceName}`);

	const dbName = process.env.DB_NAME || 'gauzy';
	const dbUser = process.env.DB_USER
		? <string>process.env.DB_USER
		: 'gauzy_user';
	const dbPassword = process.env.DB_PASS
		? <string>process.env.DB_PASS
		: 'change_me';

	// A custom container for the backend api
	// Use the 'build' property to specify a folder that contains a Dockerfile.
	// Pulumi builds the container and pushes to an ECR registry
	const backendAPIService = new awsx.ecs.FargateService(fargateServiceName, {
		name: fargateServiceName,
		cluster,
		desiredCount: 1,
		securityGroups: cluster.securityGroups,
		taskDefinitionArgs: {
			containers: {
				backendAPI: {
					image: apiImage,
					cpu: 1024 /*100% of 1024 is 1 vCPU*/,
					memory: 2048 /*MB*/,
					portMappings: [backendAPIListener],
					environment: [
						{ name: 'DB_TYPE', value: 'postgres' },
						{ name: 'DB_HOST', value: dbHost },
						{ name: 'DB_PORT', value: dbPort.toString() },
						{ name: 'DB_PASS', value: dbPassword },
						{ name: 'DB_USER', value: dbUser },
						{ name: 'DB_NAME', value: dbName },
					],
					// command: ["redis-server", "--requirepass", redisPassword], - can be some command?
				},
			},
		},
	});

	return { backendAPIListener, backendAPIService };
};
