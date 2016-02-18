# Project Dino - massive scale load tests from AWS Lambda

## Usage

Set up an IAM user and a role first and add the credentials to `~/.aws/credentials` under `[dino]`. Then run:

```
$ npm install -g artillery-dino
$ AWS_PROFILE=dino dino setup
$ AWS_PROFILE=dino dino -n 500 -c 10 -l 20 -t http://dev.myapp.io/
```

For more information read my blog post: [Project Dino - Load testing on Lambda with Artillery](http://veldstra.org/2016/02/18/project-dino-load-testing-on-lambda-with-artillery.html).

## Contact

Hassy Veldstra <[h@artillery.io](h@artillery.io)>

## License

MPLv2 - see [LICENSE.txt](./LICENSE.txt) for details

(Note: several dependencies are bundled under `lambda/out/node_modules` -- the above MPLv2 declaration does not apply to those.)
