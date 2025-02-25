import {App, Duration, Stack} from 'aws-cdk-lib';
import {IpAddresses, Peer, Port, SecurityGroup, SubnetType, Vpc} from 'aws-cdk-lib/aws-ec2';
import {ApplicationLoadBalancer, ApplicationTargetGroup} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
    AwsLogDriverMode,
    Cluster,
    Compatibility,
    ContainerImage,
    FargateService,
    LogDriver,
    TaskDefinition
} from 'aws-cdk-lib/aws-ecs';
import {RetentionDays} from 'aws-cdk-lib/aws-logs';
import {
    AllowedMethods,
    CachePolicy,
    Distribution,
    OriginProtocolPolicy,
    OriginRequestPolicy,
    PriceClass,
    ViewerProtocolPolicy
} from 'aws-cdk-lib/aws-cloudfront';
import {FunctionUrlOrigin, LoadBalancerV2Origin, OriginGroup} from 'aws-cdk-lib/aws-cloudfront-origins';
import {CertificateValidation, DnsValidatedCertificate} from "aws-cdk-lib/aws-certificatemanager";
import {ARecord, HostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {CloudFrontTarget} from "aws-cdk-lib/aws-route53-targets";
import {
    AdjustmentType,
    CfnScalingPolicy,
    ScalableTarget,
    ServiceNamespace,
} from 'aws-cdk-lib/aws-applicationautoscaling';
import {Alarm, CfnAlarm, ComparisonOperator, TreatMissingData} from "aws-cdk-lib/aws-cloudwatch";
import {NodejsFunction} from "aws-cdk-lib/aws-lambda-nodejs";
import {FunctionUrlAuthType, Runtime} from "aws-cdk-lib/aws-lambda";
import path from "node:path";
import {Effect, PolicyStatement} from "aws-cdk-lib/aws-iam";

const HOSTED_ZONE_NAME = 'jsmarket.cz';
const APP_SUBDOMAIN = `ecs-scale-to-zero`;
const MINUTES_TO_TERMINATE = 10;

const app = new App();
const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-2',
};

const stack = new Stack(app, 'EcsScaleToZeroCloudfrontBased', {env});

// VPC
const vpc = new Vpc(stack, 'Vpc', {
    maxAzs: 2,
    natGateways: 0,
    subnetConfiguration: [
        {
            name: 'Public',
            subnetType: SubnetType.PUBLIC,
            cidrMask: 24,
        },
        {
            name: 'Private',
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            cidrMask: 24,
        },
    ],
    ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
});

// Nginx fargate service
const cluster = new Cluster(stack, 'EcsCluster', {
    vpc,
    enableFargateCapacityProviders: true,
});
const taskDefinition = new TaskDefinition(stack, 'TaskDefinition', {
    cpu: '256',
    memoryMiB: '512',
    compatibility: Compatibility.FARGATE,
});
taskDefinition.addContainer('NginxContainer', {
    image: ContainerImage.fromRegistry('nginx:alpine'),
    memoryLimitMiB: 256,
    portMappings: [{containerPort: 80}],
    logging: LogDriver.awsLogs({
        streamPrefix: 'EcsScaleToZeroStack',
        logRetention: RetentionDays.ONE_DAY,
        mode: AwsLogDriverMode.NON_BLOCKING,
    }),
});
const taskSecurityGroup = new SecurityGroup(stack, 'ServiceSecurityGroup', {
    vpc,
    allowAllOutbound: true,
});
const service = new FargateService(stack, 'EcsService', {
    cluster,
    taskDefinition,
    assignPublicIp: true,
    vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
    },
    securityGroups: [taskSecurityGroup],
    maxHealthyPercent: 200,
    minHealthyPercent: 100,
});

// load balancer
const loadBalancerSecurityGroup = new SecurityGroup(stack, 'LoadBalancerSecurityGroup', {
    vpc,
    allowAllOutbound: false,
});
loadBalancerSecurityGroup.addIngressRule(Peer.prefixList('pl-b6a144df'), Port.tcp(80), 'HTTP');
loadBalancerSecurityGroup.addEgressRule(Peer.securityGroupId(taskSecurityGroup.securityGroupId), Port.HTTP)
const lb = new ApplicationLoadBalancer(stack, 'ALB', {
    vpc,
    internetFacing: true,
    securityGroup: SecurityGroup.fromSecurityGroupId(stack, 'LoadBalancerSecurityGroupImmutable', loadBalancerSecurityGroup.securityGroupId, {
        mutable: false,
    }),
});
const targetGroup = new ApplicationTargetGroup(stack, 'TargetGroup', {
    vpc,
    targets: [service],
    port: 80,
});
const listener = lb.addListener('Listener', {
    port: 80,
    defaultTargetGroups: [targetGroup],
});

// Termination alarm
const requestsMetric = targetGroup.metrics.requestCountPerTarget({
    period: Duration.minutes(1),
});
const target = new ScalableTarget(stack, 'Target', {
    minCapacity: 0,
    maxCapacity: 1,
    resourceId: `service/${cluster.clusterName}/${service.serviceName}`,
    scalableDimension: 'ecs:service:DesiredCount',
    serviceNamespace: ServiceNamespace.ECS,
})
const scalingPolicy = new CfnScalingPolicy(stack, 'ScalingPolicy', {
    policyName: 'EcsScaleToZeroPolicy',
    scalingTargetId: target.scalableTargetId,

    policyType: 'StepScaling',
    stepScalingPolicyConfiguration: {
        adjustmentType: AdjustmentType.EXACT_CAPACITY,
        stepAdjustments: [
            {
                scalingAdjustment: 0,
                metricIntervalUpperBound: 0,
            }
        ]
    }
})
const alarm = new Alarm(stack, 'TerminationAlarm', {
    metric: requestsMetric,
    comparisonOperator: ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
    threshold: 0,
    evaluationPeriods: MINUTES_TO_TERMINATE,
    datapointsToAlarm: MINUTES_TO_TERMINATE,
    treatMissingData: TreatMissingData.MISSING,
});
(alarm.node.defaultChild as CfnAlarm).alarmActions = [scalingPolicy.attrArn];

// start lambda
const startupLambda = new NodejsFunction(stack, 'StartupLambda', {
    entry: path.join(__dirname, 'start-lambda.ts'),
    handler: 'handler',
    runtime: Runtime.NODEJS_22_X,
    timeout: Duration.minutes(3),
    logRetention: RetentionDays.THREE_DAYS,
    environment: {
        REGION: stack.region,
        CLUSTER_NAME: cluster.clusterName,
        SERVICE_NAME: service.serviceName,
        DOMAIN:`${APP_SUBDOMAIN}.${HOSTED_ZONE_NAME}`,
    },
});
startupLambda.role?.addToPrincipalPolicy(new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
        'ecs:UpdateService',
        'ecs:DescribeServices',
    ],
    resources: [
        `arn:aws:ecs:${stack.region}:${stack.account}:service/${cluster.clusterName}/${service.serviceName}`
    ]
}))
startupLambda.role?.addToPrincipalPolicy(new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
        'ecs:ListTasks',
    ],
    resources: [
        `arn:aws:ecs:${stack.region}:${stack.account}:container-instance/${cluster.clusterName}/*`,
    ]
}))
startupLambda.role?.addToPrincipalPolicy(new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
        'ecs:DescribeTasks',
    ],
    resources: [
        `arn:aws:ecs:${stack.region}:${stack.account}:task/${cluster.clusterName}/*`,
    ]
}))
const lambdaUrl = startupLambda.addFunctionUrl({
    authType: FunctionUrlAuthType.AWS_IAM,
})

// CloudFront
const originGroup = new OriginGroup({
    primaryOrigin: new LoadBalancerV2Origin(lb, {
        protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
    }),
    fallbackOrigin: FunctionUrlOrigin.withOriginAccessControl(lambdaUrl),
    fallbackStatusCodes: [503]
});
const hostedZone = HostedZone.fromLookup(stack, 'HostedZone', {
    domainName: 'jsmarket.cz'
})
const certificate = new DnsValidatedCertificate(stack, 'CloudFrontCertificate', {
    hostedZone,
    region: 'us-east-1',
    domainName: `${APP_SUBDOMAIN}.${HOSTED_ZONE_NAME}`,
    validation: CertificateValidation.fromDns(hostedZone),
})
const distribution = new Distribution(stack, 'CloudFront', {
    priceClass: PriceClass.PRICE_CLASS_100,
    certificate,
    domainNames: [`${APP_SUBDOMAIN}.${HOSTED_ZONE_NAME}`],
    defaultBehavior: {
        origin: originGroup,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    }
})
new ARecord(stack, 'CloudFrontDNSRecord', {
    target: RecordTarget.fromAlias(new CloudFrontTarget(distribution)),
    zone: hostedZone,
    recordName: APP_SUBDOMAIN,
})
