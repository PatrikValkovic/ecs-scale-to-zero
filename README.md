# ECS Scale to zero

Sample application and source code demonstrating how to achieve scale to zero in Amazon Web Services.

## Using CloudFront

The behavior is described in post on [Medium](https://medium.com/qest/ecs-scale-to-zero-using-cloudfront-8b7dcb61b59b). Read for more info.

Deployment is implemented in the [src/deploy-cf.ts](src/deploy-cf.ts) file. The startup lambda is implemented in [src/start-lambda.ts](src/start-lambda.ts)

Diagram of the whole architecture:

![ecs-scale-to-zero](./cloudfront.png)
