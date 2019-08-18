require("dotenv").config();

import * as cloud from "@pulumi/cloud-aws";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as db from './db';

(async () => {  
    const dbCluster = await db.createPostgreSQLCluster();
})();