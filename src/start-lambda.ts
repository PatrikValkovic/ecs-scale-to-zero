import {ECS} from '@aws-sdk/client-ecs';
import {APIGatewayProxyHandlerV2} from 'aws-lambda';

const config = {
    region: process.env.REGION as string,
    clusterName: process.env.CLUSTER_NAME as string,
    serviceName: process.env.SERVICE_NAME as string,
    domain: process.env.DOMAIN as string,
}

const sleepPromise = (waitTime: number = 100) => new Promise(resolve => setTimeout(resolve, waitTime));

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
    const ecs = new ECS({
        region: config.region,
    });
    const currentTask = await ecs.describeServices({
        cluster: config.clusterName,
        services: [config.serviceName],
    });
    if (currentTask.services?.some(service => service.desiredCount !== 1))
        await ecs.updateService({
            cluster: config.clusterName,
            service: config.serviceName,
            desiredCount: 1,
        });

    const waitForTaskToBeRunning = async () => {
        while (true) {
            const tasks = await ecs.listTasks({
                cluster: config.clusterName,
                serviceName: config.serviceName,
            });
            const taskArns = tasks.taskArns;
            if(!taskArns || taskArns.length === 0) {
                await sleepPromise();
                continue;
            }
            const taskStatus = await ecs.describeTasks({
                cluster: config.clusterName,
                tasks: taskArns,
            });
            if(taskStatus.tasks?.some(task => task.lastStatus === 'RUNNING' && task.desiredStatus === 'RUNNING'))
                return;
            await sleepPromise();
        }
    };
    await waitForTaskToBeRunning();
    await sleepPromise(1000);

    const headers = new Headers();
    for (const [key, value] of Object.entries(event.headers)) {
        headers.set(key, value as string);
    }
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(event.queryStringParameters || {})) {
        searchParams.set(key, value as string);
    }
    const fetchResponse = await fetch(`https://${config.domain}${event.requestContext.http.path}${searchParams.size > 0 ? `?${searchParams.toString()}` : ''}`, {
        method: event.requestContext.http.method,
        headers,
        ...(event.body ? {body: Buffer.from(event.body)} : {}),
    });
    const fetchResponseContent = Buffer.from(await fetchResponse.bytes());
    const responseHeaders = [...fetchResponse.headers.entries()].reduce(
        (acc, [key, value]) => ({
            ...acc,
            [key]: value,
        }),
        {}
    );

    return {
        statusCode: fetchResponse.status,
        body: fetchResponseContent.toString('base64'),
        headers: responseHeaders,
        isBase64Encoded: true,
    }
}